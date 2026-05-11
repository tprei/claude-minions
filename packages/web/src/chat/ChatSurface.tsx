import { useState, useEffect, useCallback, useRef, useMemo, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Workflow, TaskNode } from "@minions/engine";
import type { CIPollResultPayload } from "@minions/engine";
import type { TranscriptEvent } from "@minions/shared";
import { useWorkflowStore, EMPTY_WORKFLOWS } from "../store/workflowStore.js";
import { useRootStore } from "../store/root.js";
import { dispatchCommand, listTranscript } from "../transport/rest.js";
import { Transcript } from "../transcript/Transcript.js";
import { connectWorkflowSse } from "../transport/sse.js";
import { providerEventToTranscript } from "../transcript/providerEventToTranscript.js";
import type { Connection } from "../connections/store.js";
import { Button } from "../components/Button.js";
import { ChatInput } from "./Input.js";
import { HelpModal } from "./HelpModal.js";
import { CostModal } from "./CostModal.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { Sheet } from "../components/Sheet.js";
import { ResizeHandle } from "../components/ResizeHandle.js";
import { Spinner } from "../components/Spinner.js";
import { useSwipeToDismiss, hasScrollableAncestor } from "../pwa/gestures.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { cx } from "../util/classnames.js";
import type { SlashCommand, SlashContext, SlashUiResult } from "./slashCommands.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { useConnectionStore } from "../connections/store.js";
import { getLayout, setLayout, subscribe as subscribePanelLayout } from "../util/panelLayout.js";
import { STATUS_LABEL } from "../views/statusToVisual.js";

const MIN_WIDTH = 80;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 380;
const CHAT_PANEL = "chat";
const MOBILE_QUERY = "(max-width: 767px)";
const SWIPE_THRESHOLD = 60;

function clampWidth(n: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
}

export interface SlashUiHandlers {
  activeId: string | null;
  openConfig: () => void;
  openHelp: () => void;
  openCost: () => void;
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
  if (action === "config") {
    h.openConfig();
    return;
  }
  if (!h.activeId) return;
  const { sessionSlug, query } = parseUrl();
  setUrlState({ connectionId: h.activeId, view: "dag", sessionSlug, query });
}

/** Tab type for the surface tablist. */
interface Tab {
  id: string;
  label: string;
}

const SURFACE_TABS: Tab[] = [
  { id: "transcript", label: "Transcript" },
];

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
    <div role="tablist" aria-label="Task surface" className="flex flex-wrap border-b border-border">
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

const CI_POLL_VISIBLE_STATUSES = new Set(["pr-open", "ci-pending", "needs-review"]);

function CIPollPill({ payload }: { payload: CIPollResultPayload }) {
  const symbol =
    payload.overallStatus === "success"
      ? "✓"
      : payload.overallStatus === "failure"
        ? "✗"
        : "⏳";
  const tone =
    payload.overallStatus === "success"
      ? "bg-emerald-900/40 text-emerald-300"
      : payload.overallStatus === "failure"
        ? "bg-red-900/40 text-red-300"
        : "bg-bg-elev text-fg-muted";
  const breakdown = payload.checks
    .map((c) => `${c.name} [${c.status}${c.conclusion ? ` / ${c.conclusion}` : ""}]`)
    .join("\n");
  return (
    <span className={cx("pill font-mono", tone)} title={breakdown || "no checks"}>
      CI {symbol} {payload.checks.length}
    </span>
  );
}

function WorkflowHeader({
  workflow,
  task,
  ciPoll,
  onClose,
}: {
  workflow: Workflow;
  task: TaskNode;
  ciPoll: CIPollResultPayload | undefined;
  onClose: () => void;
}) {
  const conn = useRootStore((s) => s.getActiveConnection());
  const [cancelOpen, setCancelOpen] = useState(false);
  const activeId = useConnectionStore((s) => s.activeId);

  const canCancel = workflow.status === "active" &&
    (task.executionStatus === "running" || task.executionStatus === "ready" || task.executionStatus === "pending");

  const handleCancel = useCallback(async (): Promise<void> => {
    if (!conn) return;
    await dispatchCommand(conn, {
      kind: "transition-task",
      workflowId: workflow.id,
      transition: {
        kind: "cancel",
        taskId: task.id,
        now: new Date().toISOString(),
      },
    });
  }, [conn, workflow.id, task.id]);

  const goToDag = useCallback(() => {
    if (!activeId) return;
    const { view, query } = parseUrl();
    setUrlState({ connectionId: activeId, view: "dag", sessionSlug: null, query: { ...query, dag: workflow.id } });
  }, [activeId, workflow.id]);

  const isMultiTask = Object.keys(workflow.graph).length > 1;

  return (
    <div className="flex flex-col gap-1 px-3 py-2 border-b border-border">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium text-fg truncate flex-1">{task.title}</span>
        {canCancel && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => setCancelOpen(true)}
            title="Cancel task"
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
      {canCancel && (
        <ConfirmDialog
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
          onConfirm={handleCancel}
          title="Cancel task"
          body={<p>Cancel this task? The agent will be stopped.</p>}
          confirmLabel="Cancel"
          variant="danger"
        />
      )}
      <div className="flex items-center flex-wrap gap-1.5 text-[10px]">
        <span className="pill bg-bg-elev text-fg-muted font-mono">{workflow.kind}</span>
        <span className="pill bg-bg-elev text-fg-muted">{STATUS_LABEL[task.executionStatus]}</span>
        {task.stackStatus !== "clean" && (
          <span className="pill bg-amber-900/40 text-amber-300">{task.stackStatus}</span>
        )}
        {task.artifacts.map((a, i) => (
          <span key={i} className="pill bg-bg-elev text-fg-subtle font-mono truncate max-w-[180px]" title={a.ref}>
            {a.kind}: {a.ref.slice(0, 40)}
          </span>
        ))}
        {ciPoll !== undefined && CI_POLL_VISIBLE_STATUSES.has(task.executionStatus) && (
          <CIPollPill payload={ciPoll} />
        )}
        {isMultiTask && (
          <button
            type="button"
            onClick={goToDag}
            className="pill bg-indigo-900/40 text-indigo-300 hover:underline font-mono"
            title="Open DAG view"
          >
            DAG
          </button>
        )}
      </div>
    </div>
  );
}

interface PanelProps {
  workflow: Workflow;
  task: TaskNode;
  activeTab: string;
  onTabChange: (id: string) => void;
  onClose: () => void;
  onOpenConfig?: () => void;
  onOpenHelp: () => void;
  onOpenCost: () => void;
}

const NOOP = (): void => {};

function SurfacePanel({
  workflow,
  task,
  activeTab,
  onTabChange,
  onClose,
  onOpenConfig,
  onOpenHelp,
  onOpenCost,
}: PanelProps) {
  const conn = useRootStore((s) => s.getActiveConnection());
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const tabPanelRef = useRef<HTMLDivElement | null>(null);
  const [ciPollByTask, setCiPollByTask] = useState<Record<string, CIPollResultPayload>>({});

  useEffect(() => {
    if (!conn) return;
    const sseConn = connectWorkflowSse(conn, workflow.id, {
      onEvent(e) {
        if (e.kind !== "ci-poll-result") return;
        const payload = e.payload;
        setCiPollByTask((prev) => ({ ...prev, [payload.taskId]: payload }));
      },
    });
    return () => {
      sseConn.close();
    };
  }, [conn, workflow.id]);

  const ciPoll = useMemo(() => ciPollByTask[task.id], [ciPollByTask, task.id]);

  useEffect(() => {
    if (!isMobile) return;
    const el = tabPanelRef.current;
    if (!el) return;

    let start: { x: number; y: number; ignore: boolean } | null = null;

    const onPointerDown = (e: PointerEvent): void => {
      const ignore = hasScrollableAncestor(e.target, el, "x");
      start = { x: e.clientX, y: e.clientY, ignore };
    };

    const onPointerUp = (e: PointerEvent): void => {
      const s = start;
      start = null;
      if (!s || s.ignore) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (Math.abs(dx) <= Math.abs(dy)) return;
      if (Math.abs(dx) < SWIPE_THRESHOLD) return;
      const idx = SURFACE_TABS.findIndex((t) => t.id === activeTab);
      if (idx < 0) return;
      const nextIdx = dx < 0 ? idx + 1 : idx - 1;
      if (nextIdx < 0 || nextIdx >= SURFACE_TABS.length) return;
      const next = SURFACE_TABS[nextIdx];
      if (next) onTabChange(next.id);
    };

    const onPointerCancel = (): void => {
      start = null;
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [isMobile, activeTab, onTabChange]);

  const handleSlashCommand = useCallback(
    async (cmd: SlashCommand, args: string[]) => {
      if (!conn) return;
      const ctx: SlashContext = { sessionSlug: task.id, dagId: workflow.id };
      const result = cmd.build(args, ctx);
      if (result.kind === "ui") {
        dispatchSlashUi(result.action, {
          activeId: useConnectionStore.getState().activeId,
          openConfig: onOpenConfig ?? NOOP,
          openHelp: onOpenHelp,
          openCost: onOpenCost,
        });
      }
    },
    [task.id, workflow.id, conn, onOpenConfig, onOpenHelp, onOpenCost],
  );

  const isActive = task.executionStatus === "running" || task.executionStatus === "ready";
  const isTerminal = ["completed", "pr-open", "merged", "failed", "cancelled"].includes(task.executionStatus);

  const handleSubmit = useCallback(
    async (text: string) => {
      if (!conn) return;
      await dispatchCommand(conn, {
        kind: "continue-task",
        workflowId: workflow.id,
        taskId: task.id,
        prompt: text,
      });
    },
    [task.id, workflow.id, conn],
  );

  const handleStop = useCallback(async () => {
    if (!conn) return;
    await dispatchCommand(conn, {
      kind: "transition-task",
      workflowId: workflow.id,
      transition: {
        kind: "cancel",
        taskId: task.id,
        now: new Date().toISOString(),
      },
    });
  }, [conn, workflow.id, task.id]);

  const inputDisabled = !conn || isTerminal;
  const inputPlaceholder = inputDisabled
    ? `Task ${task.executionStatus}.`
    : isActive
      ? "Reply queues mid-run…"
      : undefined;

  return (
    <div className="flex flex-col h-full bg-bg-soft">
      <WorkflowHeader workflow={workflow} task={task} ciPoll={ciPoll} onClose={onClose} />
      <SurfaceTablist tabs={SURFACE_TABS} active={activeTab} onChange={onTabChange} />
      <div
        ref={tabPanelRef}
        role="tabpanel"
        aria-labelledby={`surface-tab-${activeTab}`}
        className="flex-1 min-h-0 flex flex-col overflow-hidden"
      >
        {activeTab === "transcript" && (
          <TranscriptPanel task={task} workflowId={workflow.id} conn={conn} />
        )}
      </div>
      <ChatInput
        onSubmit={handleSubmit}
        onSlashCommand={handleSlashCommand}
        disabled={inputDisabled}
        placeholder={inputPlaceholder}
        hint={isActive ? "(injected mid-run)" : undefined}
        running={isActive}
        onStop={handleStop}
      />
    </div>
  );
}

function TranscriptPanel({
  task,
  workflowId,
  conn,
}: {
  task: TaskNode;
  workflowId: string;
  conn: Connection | null;
}) {
  const hasRuns = task.runs.length > 0;
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [hydrating, setHydrating] = useState(false);

  // Reset transcript when the active task or workflow changes
  const taskKey = `${workflowId}:${task.id}`;

  useEffect(() => {
    setEvents([]);
  }, [taskKey]);

  // Seed transcript from persisted store when a run is available
  const latestRunId = task.runs[0]?.id;
  useEffect(() => {
    if (!conn || !latestRunId) return;
    let cancelled = false;
    setHydrating(true);
    listTranscript(conn, workflowId, latestRunId)
      .then(({ transcript }) => {
        if (cancelled) return;
        const seeded = transcript.flatMap((entry) => {
          const te = providerEventToTranscript(entry.providerEvent, task.id, task.runs.length, entry.occurredAt);
          return te !== null ? [te] : [];
        });
        setEvents(seeded);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });
    return () => { cancelled = true; };
  }, [conn, workflowId, task.id, latestRunId, task.runs.length]);

  useEffect(() => {
    if (!conn) return;

    const sseConn = connectWorkflowSse(conn, workflowId, {
      onEvent(e) {
        if (e.kind !== "provider-event") return;
        if (e.payload.taskId !== task.id) return;
        const transcriptEvent = providerEventToTranscript(
          e.payload.providerEvent,
          task.id,
          task.runs.length,
          e.occurredAt,
        );
        if (transcriptEvent !== null) {
          setEvents((prev) => [...prev, transcriptEvent]);
        }
      },
    });

    return () => {
      sseConn.close();
    };
  }, [conn, workflowId, task.id, task.runs.length]);

  return (
    <div className="flex-1 overflow-y-auto">
      {!hasRuns ? (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <Spinner size="sm" />
            <p className="text-xs text-fg-subtle mt-2">Waiting for task to start…</p>
          </div>
        </div>
      ) : hydrating && events.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <Spinner size="sm" />
            <p className="text-xs text-fg-subtle mt-2">Loading transcript…</p>
          </div>
        </div>
      ) : (
        <Transcript events={events} />
      )}
      <div className="p-3 space-y-2">
        <div className="text-xs text-fg-subtle font-medium">Task details</div>
        <div className="card p-3 text-xs space-y-1">
          <div className="text-fg-muted font-medium">{task.title}</div>
          <div className="text-fg-subtle whitespace-pre-wrap break-words">{task.prompt}</div>
        </div>
        {task.runs.length > 0 && (
          <div className="text-xs text-fg-subtle font-medium mt-2">Runs ({task.runs.length})</div>
        )}
        {task.runs.map((run, i) => (
          <div key={i} className="card p-2 text-xs space-y-0.5">
            <div className="flex justify-between text-fg-subtle">
              <span className="font-mono">{run.id?.slice(0, 12) ?? `run-${i}`}</span>
              <span>{run.terminalReason ?? "in progress"}</span>
            </div>
          </div>
        ))}
      </div>
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
  const workflowsMap = useWorkflowStore(
    (s) => (activeId ? s.byConnection.get(activeId) ?? EMPTY_WORKFLOWS : EMPTY_WORKFLOWS),
  );

  const { workflow, task } = (() => {
    if (!sessionSlug) return { workflow: undefined, task: undefined };
    const direct = workflowsMap.get(sessionSlug);
    if (direct) {
      return { workflow: direct, task: Object.values(direct.graph)[0] };
    }
    for (const wf of workflowsMap.values()) {
      const t = wf.graph[sessionSlug];
      if (t) return { workflow: wf, task: t };
    }
    return { workflow: undefined, task: undefined };
  })();

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

  const primaryRef = useRef<HTMLDivElement | null>(null);
  const closeToList = useCallback(() => {
    const activeIdNow = useConnectionStore.getState().activeId;
    if (!activeIdNow) return;
    const { view, query } = parseUrl();
    setUrlState({ connectionId: activeIdNow, view, sessionSlug: null, query });
  }, []);
  useSwipeToDismiss(primaryRef, closeToList, { direction: "right", threshold: 80 });

  if (!workflow || !task) return null;

  const modals = (
    <>
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {costOpen && <CostModal workflow={workflow} onClose={() => setCostOpen(false)} />}
    </>
  );

  const panelProps: PanelProps = {
    workflow,
    task,
    activeTab,
    onTabChange: setActiveTab,
    onOpenConfig,
    onOpenHelp: () => setHelpOpen(true),
    onOpenCost: () => setCostOpen(true),
    onClose: closeToList,
  };

  if (primary) {
    return (
      <>
        <div ref={primaryRef} className="flex-1 min-w-0 min-h-0 flex flex-col bg-bg-soft">
          <SurfacePanel {...panelProps} />
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
        <Sheet open={open} onClose={() => setOpen(false)} title={task.title}>
          <div className="h-[80dvh] flex flex-col">
            <SurfacePanel {...panelProps} onClose={() => setOpen(false)} />
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
          <SurfacePanel {...panelProps} onClose={() => setOpen(false)} />
        </div>
      </div>
      {modals}
    </>
  );
}
