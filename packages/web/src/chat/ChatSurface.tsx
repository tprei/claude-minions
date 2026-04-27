import { useState, useEffect, useCallback, useRef } from "react";
import type { Session } from "@minions/shared";
import { useSessionStore } from "../store/sessionStore.js";
import { useRootStore } from "../store/root.js";
import { postCommand, postMessage, getDiff, getCheckpoints, getScreenshots, getTranscript } from "../transport/rest.js";
import { Transcript } from "../transcript/Transcript.js";
import { Diff } from "../components/Diff.js";
import { Tabs, type Tab } from "./Tabs.js";
import { ChatInput } from "./Input.js";
import { QuickActions } from "./quickActions.js";
import { Sheet } from "../components/Sheet.js";
import { ResizeHandle } from "../components/ResizeHandle.js";
import { Spinner } from "../components/Spinner.js";
import { cx } from "../util/classnames.js";
import type { SlashCommand, SlashContext } from "./slashCommands.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { useConnectionStore } from "../connections/store.js";
import type { Attachment } from "./attachments.js";
import type { WorkspaceDiff, Checkpoint, Screenshot } from "@minions/shared";

const SURFACE_TABS: Tab[] = [
  { id: "transcript", label: "Transcript" },
  { id: "diff", label: "Diff" },
  { id: "checkpoints", label: "Checkpoints" },
  { id: "screenshots", label: "Screenshots" },
  { id: "dag", label: "DAG status" },
];

const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 380;

function useSessionTranscript(session: Session) {
  const transcripts = useSessionStore((s) => s.transcripts);
  const setTranscript = useSessionStore((s) => s.setTranscript);
  const conn = useRootStore((s) => s.getActiveConnection());
  const slug = session.slug;
  const hasLoaded = transcripts.has(slug);

  useEffect(() => {
    if (!conn || hasLoaded) return;
    let cancelled = false;
    getTranscript(conn, slug)
      .then((d) => { if (!cancelled) setTranscript(slug, d.items); })
      .catch(() => { if (!cancelled) setTranscript(slug, []); });
    return () => { cancelled = true; };
  }, [conn, slug, hasLoaded, setTranscript]);

  return transcripts.get(slug) ?? [];
}

function DiffPanel({ session }: { session: Session }) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const conn = useRootStore((s) => s.getActiveConnection());

  useEffect(() => {
    if (!conn) return;
    setLoading(true);
    getDiff(conn, session.slug)
      .then((d) => setDiff(d))
      .catch(() => setDiff(null))
      .finally(() => setLoading(false));
  }, [session.slug, conn]);

  if (loading) return <div className="flex items-center justify-center h-full"><Spinner /></div>;
  if (!diff) return <div className="p-4 text-sm text-zinc-500">No diff available.</div>;
  return (
    <div className="p-4 overflow-auto flex-1">
      <Diff text={diff.patch} />
    </div>
  );
}

function CheckpointsPanel({ session }: { session: Session }) {
  const [items, setItems] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const conn = useRootStore((s) => s.getActiveConnection());

  useEffect(() => {
    if (!conn) return;
    setLoading(true);
    getCheckpoints(conn, session.slug)
      .then((d) => setItems(d.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [session.slug, conn]);

  if (loading) return <div className="flex items-center justify-center h-full"><Spinner /></div>;
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-2">
      {items.length === 0 && <p className="text-sm text-zinc-500">No checkpoints.</p>}
      {items.map((c) => (
        <div key={c.id} className="card p-3 text-sm">
          <div className="text-zinc-100 font-mono text-xs">{c.id.slice(0, 8)}</div>
          <div className="text-zinc-400 mt-0.5">{c.message}</div>
          <div className="text-zinc-600 text-xs mt-1">turn {c.turn}</div>
        </div>
      ))}
    </div>
  );
}

function ScreenshotsPanel({ session }: { session: Session }) {
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [loading, setLoading] = useState(true);
  const conn = useRootStore((s) => s.getActiveConnection());

  useEffect(() => {
    if (!conn) return;
    setLoading(true);
    getScreenshots(conn, session.slug)
      .then((d) => setScreenshots(d.items))
      .catch(() => setScreenshots([]))
      .finally(() => setLoading(false));
  }, [session.slug, conn]);

  if (loading) return <div className="flex items-center justify-center h-full"><Spinner /></div>;
  return (
    <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 gap-2">
      {screenshots.length === 0 && <p className="text-sm text-zinc-500 col-span-2">No screenshots.</p>}
      {screenshots.map((s) => (
        <img
          key={s.filename}
          src={`/api/sessions/${session.slug}/screenshots/${s.filename}`}
          alt={s.filename}
          className="rounded border border-border w-full"
        />
      ))}
    </div>
  );
}

function DagStatusPanel({ session }: { session: Session }) {
  const activeId = useConnectionStore((s) => s.activeId);

  if (!session.dagId) {
    return <div className="p-4 text-sm text-zinc-500">No DAG linked to this session.</div>;
  }
  return (
    <div className="p-4 text-sm text-zinc-300">
      <div>DAG: <span className="font-mono text-zinc-400">{session.dagId}</span></div>
      {session.dagNodeId && (
        <div className="mt-1">Node: <span className="font-mono text-zinc-400">{session.dagNodeId}</span></div>
      )}
      <button
        type="button"
        onClick={() => {
          if (!activeId) return;
          const { sessionSlug, query } = parseUrl();
          setUrlState({ connectionId: activeId, view: "dag", sessionSlug, query: { ...query, dag: session.dagId ?? "" } });
        }}
        className="btn mt-3 text-xs"
      >
        Open DAG canvas →
      </button>
    </div>
  );
}

interface PanelProps {
  session: Session;
  activeTab: string;
  onTabChange: (id: string) => void;
  onClose: () => void;
}

function SurfacePanel({ session, activeTab, onTabChange, onClose }: PanelProps) {
  const events = useSessionTranscript(session);
  const conn = useRootStore((s) => s.getActiveConnection());

  const handleSlashCommand = useCallback(
    async (cmd: SlashCommand, args: string[]) => {
      if (!conn) return;
      const ctx: SlashContext = { sessionSlug: session.slug, dagId: session.dagId };
      const result = cmd.build(args, ctx);
      if (result.kind === "command") {
        await postCommand(conn, result.payload);
      } else if (result.kind === "message") {
        await postMessage(conn, { prompt: args.join(" "), mode: result.payload.mode });
      } else if (result.kind === "ui") {
        const activeId = useConnectionStore.getState().activeId;
        if (!activeId) return;
        if (result.action === "loops") {
          const { sessionSlug, query } = parseUrl();
          setUrlState({ connectionId: activeId, view: "loops", sessionSlug, query });
        }
      }
    },
    [session, conn],
  );

  const handleSubmit = useCallback(
    async (text: string, attachments: Attachment[]) => {
      if (!conn) return;
      await postCommand(conn, {
        kind: "reply",
        sessionSlug: session.slug,
        text,
        attachments: attachments.map((a) => ({
          name: a.name,
          mimeType: a.mimeType,
          dataBase64: a.dataBase64,
        })),
      });
    },
    [session.slug, conn],
  );

  const inputDisabled = !conn || session.status === "completed" || session.status === "cancelled";

  return (
    <div className="flex flex-col h-full bg-bg-soft">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-zinc-200 truncate flex-1">{session.title}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 text-lg leading-none"
          title="Close (press ?)"
        >
          ×
        </button>
      </div>
      <Tabs tabs={SURFACE_TABS} active={activeTab} onChange={onTabChange} />
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {activeTab === "transcript" && <Transcript events={events} />}
        {activeTab === "diff" && <DiffPanel session={session} />}
        {activeTab === "checkpoints" && <CheckpointsPanel session={session} />}
        {activeTab === "screenshots" && <ScreenshotsPanel session={session} />}
        {activeTab === "dag" && <DagStatusPanel session={session} />}
      </div>
      <QuickActions session={session} />
      <ChatInput
        onSubmit={handleSubmit}
        onSlashCommand={handleSlashCommand}
        disabled={inputDisabled}
        placeholder={inputDisabled && session.status !== "running" ? "Session ended." : undefined}
      />
    </div>
  );
}

interface Props {
  sessionSlug?: string | null;
}

export function ChatSurface({ sessionSlug }: Props) {
  const [open, setOpen] = useState(true);
  const [activeTab, setActiveTab] = useState("transcript");
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const sessionsMap = useSessionStore((s) => s.sessions);

  const session = sessionSlug ? sessionsMap.get(sessionSlug) : undefined;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "?" && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) {
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleDrag = useCallback((delta: number) => {
    setWidth((w) => Math.max(MIN_WIDTH, w - delta));
  }, []);

  if (!session) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 btn text-xs z-40"
      >
        💬 Open chat (?)
      </button>
    );
  }

  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

  if (isMobile) {
    return (
      <Sheet open={open} onClose={() => setOpen(false)} title={session.title}>
        <div className="h-[80vh] flex flex-col">
          <SurfacePanel
            session={session}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onClose={() => setOpen(false)}
          />
        </div>
      </Sheet>
    );
  }

  return (
    <div className="fixed right-0 top-0 bottom-0 flex z-30" style={{ width }}>
      <ResizeHandle onDrag={handleDrag} />
      <div className="flex-1 flex flex-col shadow-2xl border-l border-border">
        <SurfacePanel
          session={session}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onClose={() => setOpen(false)}
        />
      </div>
    </div>
  );
}
