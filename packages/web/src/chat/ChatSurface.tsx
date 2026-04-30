import { useState, useEffect, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Session, SessionStatus } from "@minions/shared";
import { useSessionStore, EMPTY_SESSIONS, EMPTY_TRANSCRIPTS } from "../store/sessionStore.js";
import { useRootStore } from "../store/root.js";
import { postCommand, postMessage, getDiff, getCheckpoints, getScreenshots, getTranscript } from "../transport/rest.js";
import { Transcript } from "../transcript/Transcript.js";
import { Diff } from "../components/Diff.js";
import { Button } from "../components/Button.js";
import { type Tab } from "./Tabs.js";
import { ChatInput } from "./Input.js";
import { HelpModal } from "./HelpModal.js";
import { CostModal } from "./CostModal.js";
import { QuickActions } from "./quickActions.js";
import { RecoveryFooter } from "./RecoveryFooter.js";
import { PRPanel } from "./PRPanel.js";
import { CancelSessionDialog } from "./cancelSession.js";
import { Sheet } from "../components/Sheet.js";
import { ResizeHandle } from "../components/ResizeHandle.js";
import { Spinner } from "../components/Spinner.js";
import { cx } from "../util/classnames.js";
import type { SlashCommand, SlashContext, SlashUiResult } from "./slashCommands.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { useConnectionStore } from "../connections/store.js";
import type { Attachment } from "./attachments.js";
import type { Command, WorkspaceDiff, Checkpoint, Screenshot } from "@minions/shared";
import { getLayout, setLayout, subscribe as subscribePanelLayout } from "../util/panelLayout.js";

const SURFACE_TABS: Tab[] = [
  { id: "transcript", label: "Transcript" },
  { id: "diff", label: "Diff" },
  { id: "pr", label: "PR" },
  { id: "checkpoints", label: "Checkpoints" },
  { id: "screenshots", label: "Screenshots" },
  { id: "dag", label: "DAG status" },
];

const CANCELLABLE_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "pending",
  "running",
  "waiting_input",
]);

const MIN_WIDTH = 80;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 380;
const CHAT_PANEL = "chat";

function clampWidth(n: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
}

export interface SlashUiHandlers {
  activeId: string | null;
  openConfig: () => void;
  openHelp: () => void;
  openCost: () => void;
  setActiveTab: (id: string) => void;
}

export function dispatchSlashUi(action: SlashUiResult["action"], h: SlashUiHandlers): void {
  if (action === "help") {
    h.openHelp();
    return;
  }
  if (action === "cost") {
    h.openCost();
    return;
  }
  if (action === "diff") {
    h.setActiveTab("diff");
    return;
  }
  if (action === "config") {
    h.openConfig();
    return;
  }
  if (!h.activeId) return;
  const { sessionSlug, query } = parseUrl();
  const view = action === "loops" ? "loops" : "doctor";
  setUrlState({ connectionId: h.activeId, view, sessionSlug, query });
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

function AuthedImage({ session, filename }: { session: Session; filename: string }) {
  const conn = useRootStore((s) => s.getActiveConnection());
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!conn) return;
    let cancelled = false;
    let blobUrl: string | null = null;
    const url = `${conn.baseUrl.replace(/\/$/, "")}/api/sessions/${session.slug}/screenshots/${encodeURIComponent(filename)}`;
    fetch(url, { headers: { Authorization: `Bearer ${conn.token}` } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        blobUrl = URL.createObjectURL(blob);
        setSrc(blobUrl);
      })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [conn, session.slug, filename]);
  if (err) return <div className="text-xs text-err p-2 border border-border rounded">load failed: {err}</div>;
  if (!src) return <div className="text-xs text-fg-subtle p-2 border border-border rounded animate-pulse">loading…</div>;
  return <img src={src} alt={filename} className="rounded border border-border w-full" />;
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
        <div key={s.filename} className="flex flex-col gap-1">
          <AuthedImage session={session} filename={s.filename} />
          <span className="text-[10px] font-mono text-fg-subtle truncate" title={s.filename}>{s.filename}</span>
        </div>
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

const PR_STATE_PILL: Record<"open" | "closed" | "merged", string> = {
  open: "bg-emerald-900/40 text-emerald-300",
  merged: "bg-purple-900/40 text-purple-300",
  closed: "bg-bg-elev text-fg-muted",
};

export function BudgetMeterPill({ costUsd, cap }: { costUsd: number; cap: number }) {
  const safeCost = costUsd > 0 ? costUsd : 0;
  const ratio = cap > 0 ? safeCost / cap : 0;
  const widthPct = Math.min(100, ratio * 100);
  const tone = ratio >= 1 ? "bg-err" : ratio >= 0.8 ? "bg-warn" : "bg-accent";
  const textTone = ratio >= 1 ? "text-err" : ratio >= 0.8 ? "text-warn" : "text-fg-muted";
  return (
    <span
      data-testid="budget-meter"
      className={cx("pill bg-bg-elev font-mono relative overflow-hidden", textTone)}
      title={`cost ${safeCost.toFixed(2)} of ${cap.toFixed(2)} USD cap`}
    >
      <span
        aria-hidden="true"
        className={cx("absolute left-0 bottom-0 h-0.5 transition-[width]", tone)}
        style={{ width: `${widthPct}%` }}
      />
      ${safeCost.toFixed(2)} / ${cap.toFixed(2)}
    </span>
  );
}

function OperationalHeader({ session, onClose }: { session: Session; onClose: () => void }) {
  const conn = useRootStore((s) => s.getActiveConnection());
  const [landing, setLanding] = useState(false);
  const [landError, setLandError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  function navTo(view: "list" | "dag", slug?: string | null, dagId?: string) {
    const activeId = useConnectionStore.getState().activeId;
    if (!activeId) return;
    const { query } = parseUrl();
    const nextQuery = dagId ? { ...query, dag: dagId } : query;
    setUrlState({ connectionId: activeId, view, sessionSlug: slug ?? null, query: nextQuery });
  }

  const canLand =
    !!conn &&
    session.status === "completed" &&
    !!session.branch &&
    !session.pr;

  const canCancel = !!conn && CANCELLABLE_STATUSES.has(session.status);

  const handleLand = async () => {
    if (!conn || landing) return;
    setLanding(true);
    setLandError(null);
    try {
      await postCommand(conn, {
        kind: "land",
        sessionSlug: session.slug,
        strategy: "squash",
        force: false,
      });
    } catch (e) {
      setLandError(e instanceof Error ? e.message : String(e));
    } finally {
      setLanding(false);
    }
  };

  const shortParent = session.parentSlug ? session.parentSlug.slice(0, 8) : null;
  return (
    <div className="flex flex-col gap-1 px-3 py-2 border-b border-border">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium text-fg truncate flex-1">{session.title}</span>
        {canLand && (
          <button
            type="button"
            onClick={() => void handleLand()}
            disabled={landing}
            className={cx("btn-primary text-xs px-2 py-1", landing && "opacity-50 cursor-not-allowed")}
            title={`Land branch ${session.branch} (squash)`}
          >
            {landing ? "Landing…" : "Land"}
          </button>
        )}
        {canCancel && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => setCancelOpen(true)}
            title="Cancel session"
          >
            Cancel
          </Button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-fg-subtle hover:text-fg-muted text-lg leading-none"
          title="Close (return to list)"
        >
          ×
        </button>
      </div>
      {conn && (
        <CancelSessionDialog
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
          sessions={[{ slug: session.slug, title: session.title }]}
          conn={conn}
        />
      )}
      {landError && (
        <p className="text-[10px] text-err truncate" title={landError}>
          Land failed: {landError}
        </p>
      )}
      <div className="flex items-center flex-wrap gap-1.5 text-[10px]">
        <span className="pill bg-bg-elev text-fg-muted font-mono">{session.mode}</span>
        {session.shipStage && (
          <span className="pill bg-purple-900/40 text-purple-300">stage:{session.shipStage}</span>
        )}
        {session.branch && (
          <span className="pill bg-bg-elev text-fg-subtle font-mono truncate max-w-[180px]" title={session.branch}>
            ⎇ {session.branch}
          </span>
        )}
        {session.pr && (
          <a
            href={session.pr.url}
            target="_blank"
            rel="noreferrer"
            className={cx("pill font-mono hover:underline", PR_STATE_PILL[session.pr.state])}
            title={session.pr.title}
          >
            PR #{session.pr.number} · {session.pr.state}{session.pr.draft ? " (draft)" : ""}
          </a>
        )}
        {session.attention && session.attention.length > 0 && (
          <span className="pill bg-amber-900/40 text-amber-300" title={session.attention.map((a) => a.kind).join(", ")}>
            ⚠ {session.attention.length}
          </span>
        )}
        {session.costBudgetUsd !== undefined && session.costBudgetUsd > 0 && (
          <BudgetMeterPill costUsd={session.stats.costUsd} cap={session.costBudgetUsd} />
        )}
        {shortParent && (
          <button
            type="button"
            onClick={() => navTo("list", session.parentSlug)}
            className="pill bg-bg-elev text-fg-subtle hover:text-fg font-mono"
            title={`parent: ${session.parentSlug}`}
          >
            ↑ {shortParent}
          </button>
        )}
        {session.dagId && (
          <button
            type="button"
            onClick={() => navTo("dag", null, session.dagId)}
            className="pill bg-indigo-900/40 text-indigo-300 hover:underline font-mono"
            title={`DAG ${session.dagId}`}
          >
            DAG
          </button>
        )}
        {session.childSlugs && session.childSlugs.length > 0 && (
          <span className="pill bg-bg-elev text-fg-subtle">↓ {session.childSlugs.length}</span>
        )}
        {session.modelHint && (
          <span className="pill bg-bg-elev text-fg-subtle font-mono truncate max-w-[140px]" title={session.modelHint}>
            {session.modelHint}
          </span>
        )}
      </div>
    </div>
  );
}

interface SurfaceTablistProps {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
}

function SurfaceTablist({ tabs, active, onChange }: SurfaceTablistProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const activate = useCallback(
    (id: string) => {
      onChange(id);
      queueMicrotask(() => refs.current[id]?.focus());
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>, idx: number) => {
      let nextIdx = -1;
      if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
      else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = tabs.length - 1;
      if (nextIdx < 0) return;
      e.preventDefault();
      const next = tabs[nextIdx];
      if (next) activate(next.id);
    },
    [tabs, activate],
  );

  return (
    <div role="tablist" aria-label="Session surface" className="flex flex-wrap border-b border-border">
      {tabs.map((tab, idx) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[tab.id] = el;
            }}
            type="button"
            role="tab"
            id={`surface-tab-${tab.id}`}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={cx(
              "px-3 py-2 text-xs transition-colors whitespace-nowrap",
              isActive
                ? "text-fg border-b-2 border-accent -mb-px"
                : "text-fg-subtle hover:text-fg-muted",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

interface PanelProps {
  session: Session;
  activeTab: string;
  onTabChange: (id: string) => void;
  onClose: () => void;
  onOpenConfig?: () => void;
  onOpenHelp: () => void;
  onOpenCost: () => void;
}

const NOOP = (): void => {};

function SurfacePanel({ session, activeTab, onTabChange, onClose, onOpenConfig, onOpenHelp, onOpenCost }: PanelProps) {
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
        dispatchSlashUi(result.action, {
          activeId: useConnectionStore.getState().activeId,
          openConfig: onOpenConfig ?? NOOP,
          openHelp: onOpenHelp,
          openCost: onOpenCost,
          setActiveTab: onTabChange,
        });
      }
    },
    [session, conn, onOpenConfig, onOpenHelp, onOpenCost, onTabChange],
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
      <OperationalHeader session={session} onClose={onClose} />
      <SurfaceTablist tabs={SURFACE_TABS} active={activeTab} onChange={onTabChange} />
      <div
        role="tabpanel"
        aria-labelledby={`surface-tab-${activeTab}`}
        className="flex-1 min-h-0 flex flex-col overflow-hidden"
      >
        {activeTab === "transcript" && <Transcript events={events} />}
        {activeTab === "diff" && <DiffPanel session={session} />}
        {activeTab === "pr" && <PRPanel session={session} />}
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
        repoId={session.repoId}
      />
    </div>
  );
}

interface Props {
  sessionSlug?: string | null;
  primary?: boolean;
  onOpenConfig?: () => void;
}

export function ChatSurface({ sessionSlug, primary = false, onOpenConfig }: Props) {
  const [open, setOpen] = useState<boolean>(() => {
    const stored = getLayout(CHAT_PANEL);
    return stored ? !stored.collapsed : true;
  });
  const [activeTab, setActiveTab] = useState("transcript");
  const [helpOpen, setHelpOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
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

  const modals = (
    <>
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {costOpen && <CostModal session={session} onClose={() => setCostOpen(false)} />}
    </>
  );

  if (primary) {
    const closeToList = () => {
      const activeIdNow = useConnectionStore.getState().activeId;
      if (!activeIdNow) return;
      const { view, query } = parseUrl();
      setUrlState({ connectionId: activeIdNow, view, sessionSlug: null, query });
    };
    return (
      <>
        <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-bg-soft">
          <SurfacePanel
            session={session}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onClose={closeToList}
            onOpenConfig={onOpenConfig}
            onOpenHelp={() => setHelpOpen(true)}
            onOpenCost={() => setCostOpen(true)}
          />
        </div>
        {modals}
      </>
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
      <>
        <Sheet open={open} onClose={() => setOpen(false)} title={session.title}>
          <div className="h-[80vh] flex flex-col">
            <SurfacePanel
              session={session}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onClose={() => setOpen(false)}
              onOpenConfig={onOpenConfig}
              onOpenHelp={() => setHelpOpen(true)}
              onOpenCost={() => setCostOpen(true)}
            />
          </div>
        </Sheet>
        {modals}
      </>
    );
  }

  return (
    <>
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
            onOpenConfig={onOpenConfig}
            onOpenHelp={() => setHelpOpen(true)}
            onOpenCost={() => setCostOpen(true)}
          />
        </div>
      </div>
      {modals}
    </>
  );
}
