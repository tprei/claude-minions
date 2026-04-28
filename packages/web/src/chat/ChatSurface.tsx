import { useState, useEffect, useCallback, useRef } from "react";
import type { Session } from "@minions/shared";
import { useSessionStore, EMPTY_SESSIONS, EMPTY_TRANSCRIPTS } from "../store/sessionStore.js";
import { useRootStore } from "../store/root.js";
import { postCommand, postMessage, getDiff, getCheckpoints, getScreenshots, getTranscript } from "../transport/rest.js";
import { Transcript } from "../transcript/Transcript.js";
import { Diff } from "../components/Diff.js";
import { Tabs, type Tab } from "./Tabs.js";
import { ChatInput } from "./Input.js";
import { QuickActions } from "./quickActions.js";
import { RecoveryFooter } from "./RecoveryFooter.js";
import { Sheet } from "../components/Sheet.js";
import { ResizeHandle } from "../components/ResizeHandle.js";
import { Spinner } from "../components/Spinner.js";
import { cx } from "../util/classnames.js";
import type { SlashCommand, SlashContext } from "./slashCommands.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { useConnectionStore } from "../connections/store.js";
import type { Attachment } from "./attachments.js";
import type { Command, WorkspaceDiff, Checkpoint, Screenshot } from "@minions/shared";
import { getLayout, setLayout, subscribe as subscribePanelLayout } from "../util/panelLayout.js";

const SURFACE_TABS: Tab[] = [
  { id: "transcript", label: "Transcript" },
  { id: "diff", label: "Diff" },
  { id: "checkpoints", label: "Checkpoints" },
  { id: "screenshots", label: "Screenshots" },
  { id: "dag", label: "DAG status" },
];

const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 380;
const CHAT_PANEL = "chat";

function clampWidth(n: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
}

function useSessionTranscript(session: Session) {
  const conn = useRootStore((s) => s.getActiveConnection());
  const transcripts = useSessionStore(
    (s) => (conn ? s.byConnection.get(conn.id)?.transcripts ?? EMPTY_TRANSCRIPTS : EMPTY_TRANSCRIPTS),
  );
  const setTranscript = useSessionStore((s) => s.setTranscript);
  const slug = session.slug;
  const hasLoaded = transcripts.has(slug);

  useEffect(() => {
    if (!conn || hasLoaded) return;
    let cancelled = false;
    getTranscript(conn, slug)
      .then((d) => { if (!cancelled) setTranscript(conn.id, slug, d.items); })
      .catch(() => { if (!cancelled) setTranscript(conn.id, slug, []); });
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
  if (!diff) return <div className="p-4 text-sm text-fg-subtle">No diff available.</div>;
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
      {items.length === 0 && <p className="text-sm text-fg-subtle">No checkpoints.</p>}
      {items.map((c) => (
        <div key={c.id} className="card p-3 text-sm">
          <div className="text-fg font-mono text-xs">{c.id.slice(0, 8)}</div>
          <div className="text-fg-muted mt-0.5">{c.message}</div>
          <div className="text-fg-subtle text-xs mt-1">turn {c.turn}</div>
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
      {screenshots.length === 0 && <p className="text-sm text-fg-subtle col-span-2">No screenshots.</p>}
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
    return <div className="p-4 text-sm text-fg-subtle">No DAG linked to this session.</div>;
  }
  return (
    <div className="p-4 text-sm text-fg-muted">
      <div>DAG: <span className="font-mono text-fg-muted">{session.dagId}</span></div>
      {session.dagNodeId && (
        <div className="mt-1">Node: <span className="font-mono text-fg-muted">{session.dagNodeId}</span></div>
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
      const uploaded = attachments
        .filter((a) => a.url)
        .map((a) => ({ name: a.name, mimeType: a.mimeType, url: a.url! }));
      await postCommand(conn, {
        kind: "reply",
        sessionSlug: session.slug,
        text,
        ...(uploaded.length > 0 ? { attachments: uploaded } : {}),
      });
    },
    [session.slug, conn],
  );

  const handleRecoveryAction = useCallback(
    async (cmd: Command) => {
      if (!conn) throw new Error("No active connection");
      await postCommand(conn, cmd);
    },
    [conn],
  );

  const handleStop = useCallback(async () => {
    if (!conn) return;
    await postCommand(conn, { kind: "stop", sessionSlug: session.slug });
  }, [conn, session.slug]);

  const inputDisabled = !conn || session.status === "completed" || session.status === "cancelled" || session.status === "failed";
  const isRunning = session.status === "running";
  const inputPlaceholder = inputDisabled
    ? `Session ${session.status}.`
    : isRunning
      ? "Reply queues to land mid-turn…"
      : undefined;

  return (
    <div className="flex flex-col h-full bg-bg-soft">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-fg-muted truncate flex-1">{session.title}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-fg-subtle hover:text-fg-muted text-lg leading-none"
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
      <RecoveryFooter session={session} onAction={handleRecoveryAction} />
      <ChatInput
        onSubmit={handleSubmit}
        onSlashCommand={handleSlashCommand}
        disabled={inputDisabled}
        placeholder={inputPlaceholder}
        hint={isRunning ? "(injected mid-turn)" : undefined}
        running={isRunning}
        onStop={handleStop}
      />
    </div>
  );
}

interface Props {
  sessionSlug?: string | null;
  primary?: boolean;
}

export function ChatSurface({ sessionSlug, primary = false }: Props) {
  const [open, setOpen] = useState<boolean>(() => {
    const stored = getLayout(CHAT_PANEL);
    return stored ? !stored.collapsed : true;
  });
  const [activeTab, setActiveTab] = useState("transcript");
  const [width, setWidth] = useState<number>(() => {
    const stored = getLayout(CHAT_PANEL);
    return stored ? clampWidth(stored.size) : DEFAULT_WIDTH;
  });
  const activeId = useConnectionStore((s) => s.activeId);
  const sessionsMap = useSessionStore(
    (s) => (activeId ? s.byConnection.get(activeId)?.sessions ?? EMPTY_SESSIONS : EMPTY_SESSIONS),
  );

  const session = sessionSlug ? sessionsMap.get(sessionSlug) : undefined;

  useEffect(() => {
    setLayout(CHAT_PANEL, { size: width, collapsed: !open });
  }, [width, open]);

  useEffect(() => {
    return subscribePanelLayout(() => {
      const stored = getLayout(CHAT_PANEL);
      if (!stored) return;
      setWidth(clampWidth(stored.size));
      setOpen(!stored.collapsed);
    });
  }, []);

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
    setWidth((w) => clampWidth(w - delta));
  }, []);

  if (!session) return null;

  if (primary) {
    const closeToList = () => {
      const activeIdNow = useConnectionStore.getState().activeId;
      if (!activeIdNow) return;
      const { view, query } = parseUrl();
      setUrlState({ connectionId: activeIdNow, view, sessionSlug: null, query });
    };
    return (
      <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-bg-soft">
        <SurfacePanel
          session={session}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onClose={closeToList}
        />
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 btn text-xs z-40 shadow-lg"
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
    <div
      className="flex flex-shrink-0 border-l border-border bg-bg-soft min-h-0 max-w-[60vw]"
      style={{ width }}
    >
      <ResizeHandle onDrag={handleDrag} />
      <div className="flex-1 min-w-0 flex flex-col">
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
