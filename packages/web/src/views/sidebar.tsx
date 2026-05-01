import { useMemo, type ReactElement } from "react";
import { SESSION_BUCKETS, type SessionBucket } from "@minions/shared";
import { useConnectionStore } from "../connections/store.js";
import { useVersionStore } from "../store/version.js";
import { useMemoryStore, EMPTY_MEMORIES } from "../store/memoryStore.js";
import { useSessionStore, EMPTY_SESSIONS } from "../store/sessionStore.js";
import { useRuntimeStore } from "../store/runtimeStore.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl, type ViewKind } from "../routing/parseUrl.js";
import { cx } from "../util/classnames.js";

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed" | "attention";
type FilterMode = "all" | "task" | "ship" | "dag-task" | "loop";
type FilterBucket = "all" | SessionBucket;

interface SidebarProps {
  currentView: ViewKind;
  filterStatus: FilterStatus;
  filterMode: FilterMode;
  filterBucket: FilterBucket;
  onFilterStatus: (v: FilterStatus) => void;
  onFilterMode: (v: FilterMode) => void;
  onFilterBucket: (v: FilterBucket) => void;
  onOpenAudit: () => void;
  onOpenMemory: () => void;
  onOpenRuntime: () => void;
  onOpenLoops: () => void;
  onOpenDoctor: () => void;
  onNavigate?: () => void;
}

interface ViewOption {
  id: ViewKind;
  label: string;
  icon: string;
  feature?: string;
}

const VIEW_OPTIONS: ViewOption[] = [
  { id: "list", label: "List", icon: "≡" },
  { id: "kanban", label: "Kanban", icon: "⬜" },
  { id: "dag", label: "DAG", icon: "⬡", feature: "dags" },
  { id: "ship", label: "Ship", icon: "🚢", feature: "ship" },
  { id: "loops", label: "Loops", icon: "↺", feature: "loops" },
  { id: "doctor", label: "Doctor", icon: "🩺" },
];

const STATUS_FILTERS: { value: FilterStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs attention" },
  { value: "running", label: "Running" },
  { value: "waiting_input", label: "Waiting" },
  { value: "completed", label: "Done" },
  { value: "failed", label: "Failed" },
];

const MODE_FILTERS: { value: FilterMode; label: string }[] = [
  { value: "all", label: "All modes" },
  { value: "task", label: "Task" },
  { value: "ship", label: "Ship" },
  { value: "dag-task", label: "DAG task" },
  { value: "loop", label: "Loop" },
];

const BUCKET_FILTERS: { value: FilterBucket; label: string }[] = [
  { value: "all", label: "All buckets" },
  ...SESSION_BUCKETS.map((b) => ({ value: b, label: b })),
];

export function Sidebar({
  currentView,
  filterStatus,
  filterMode,
  filterBucket,
  onFilterStatus,
  onFilterMode,
  onFilterBucket,
  onOpenAudit,
  onOpenMemory,
  onOpenRuntime,
  onOpenLoops,
  onOpenDoctor,
  onNavigate,
}: SidebarProps): ReactElement {
  const activeId = useConnectionStore(s => s.activeId);
  const featureList = useVersionStore(s => (activeId ? s.byConnection.get(activeId)?.features : undefined));
  const features = useMemo(() => new Set<string>(featureList ?? []), [featureList]);
  const memoriesMap = useMemoryStore(s => (activeId ? s.byConnection.get(activeId) ?? EMPTY_MEMORIES : EMPTY_MEMORIES));
  const pendingCount = useMemo(() => {
    let n = 0;
    for (const m of memoriesMap.values()) if (m.status === "pending") n++;
    return n;
  }, [memoriesMap]);
  const sessionsMap = useSessionStore(s => (activeId ? s.byConnection.get(activeId)?.sessions ?? EMPTY_SESSIONS : EMPTY_SESSIONS));
  const attentionCount = useMemo(() => {
    let n = 0;
    for (const s of sessionsMap.values()) if (s.attention && s.attention.length > 0) n++;
    return n;
  }, [sessionsMap]);
  const admissionUnlimited = useRuntimeStore(s =>
    activeId ? s.byConnection.get(activeId)?.effective?.["admissionUnlimited"] === true : false,
  );

  function navigate(view: ViewKind): void {
    if (!activeId) return;
    const { sessionSlug, query } = parseUrl();
    setUrlState({ connectionId: activeId, view, sessionSlug, query });
    onNavigate?.();
  }

  return (
    <div className="flex flex-col h-full py-2 gap-1">
      {activeId && (
        <div className="px-2">
          <button
            onClick={() => navigate("new")}
            className={cx(
              "btn-primary w-full justify-center text-sm gap-1",
              currentView === "new" && "ring-2 ring-accent/40",
            )}
          >
            <span className="text-base leading-none">+</span>
            New session
          </button>
        </div>
      )}

      <div className="px-2">
        <p className="text-xs text-fg-subtle uppercase tracking-wider px-2 py-1">Views</p>
        {VIEW_OPTIONS.map(opt => {
          const gated = opt.feature && !features.has(opt.feature);
          return (
            <button
              key={opt.id}
              disabled={!!gated}
              onClick={() => navigate(opt.id)}
              className={cx(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left",
                currentView === opt.id
                  ? "bg-accent/20 text-fg"
                  : "text-fg-muted hover:text-fg hover:bg-bg-elev",
                gated && "opacity-40 cursor-not-allowed",
              )}
            >
              <span className="text-base w-5 text-center leading-none">{opt.icon}</span>
              {opt.label}
            </button>
          );
        })}
      </div>

      <div className="border-t border-border mx-2 my-1" />

      <div className="px-2">
        <p className="text-xs text-fg-subtle uppercase tracking-wider px-2 py-1">Status</p>
        {STATUS_FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => onFilterStatus(f.value)}
            className={cx(
              "w-full flex items-center justify-between gap-2 text-left px-2 py-2 md:py-1 min-h-10 md:min-h-0 rounded text-xs transition-colors",
              filterStatus === f.value
                ? "text-fg bg-bg-elev"
                : "text-fg-subtle hover:text-fg-muted",
            )}
          >
            <span>{f.label}</span>
            {f.value === "attention" && attentionCount > 0 && (
              <span className="pill text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{attentionCount}</span>
            )}
          </button>
        ))}
      </div>

      <div className="px-2">
        <p className="text-xs text-fg-subtle uppercase tracking-wider px-2 py-1">Mode</p>
        {MODE_FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => onFilterMode(f.value)}
            className={cx(
              "w-full text-left px-2 py-2 md:py-1 min-h-10 md:min-h-0 rounded text-xs transition-colors",
              filterMode === f.value
                ? "text-fg bg-bg-elev"
                : "text-fg-subtle hover:text-fg-muted",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="px-2">
        <p className="text-xs text-fg-subtle uppercase tracking-wider px-2 py-1">Bucket</p>
        {BUCKET_FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => onFilterBucket(f.value)}
            className={cx(
              "w-full text-left px-2 py-2 md:py-1 min-h-10 md:min-h-0 rounded text-xs transition-colors",
              filterBucket === f.value
                ? "text-fg bg-bg-elev"
                : "text-fg-subtle hover:text-fg-muted",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <div className="px-2 flex flex-col gap-0.5">
        {features.has("loops") && (
          <button onClick={onOpenLoops} className="w-full flex items-center gap-2 px-2 py-2 md:py-1.5 min-h-10 md:min-h-0 rounded-lg text-xs text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors">
            <span>↺</span> Loops
          </button>
        )}
        {features.has("memory") && (
          <button onClick={onOpenMemory} className="w-full flex items-center gap-2 px-2 py-2 md:py-1.5 min-h-10 md:min-h-0 rounded-lg text-xs text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors">
            <span>🧠</span>
            <span className="flex-1 text-left">Memory</span>
            {pendingCount > 0 && (
              <span
                className="pill bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 text-[10px]"
                title={`${pendingCount} pending memory ${pendingCount === 1 ? "review" : "reviews"}`}
              >
                {pendingCount}
              </span>
            )}
          </button>
        )}
        {features.has("runtime-overrides") && (
          <button onClick={onOpenRuntime} className="w-full flex items-center gap-2 px-2 py-2 md:py-1.5 min-h-10 md:min-h-0 rounded-lg text-xs text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors">
            <span>⚙</span>
            <span className="flex-1 text-left">Runtime</span>
            {admissionUnlimited && (
              <span
                className="pill bg-red-100 text-red-800 border border-red-300 dark:bg-red-900/60 dark:text-red-200 text-[10px] dark:border-red-700/60"
                title="Admission caps disabled — engine accepts unlimited concurrent sessions"
                data-testid="admission-unlimited-pill"
              >
                ∞
              </span>
            )}
          </button>
        )}
        {features.has("audit") && (
          <button onClick={onOpenAudit} className="w-full flex items-center gap-2 px-2 py-2 md:py-1.5 min-h-10 md:min-h-0 rounded-lg text-xs text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors">
            <span>📋</span> Audit
          </button>
        )}
        <button
          onClick={onOpenDoctor}
          className="w-full flex items-center gap-2 px-2 py-2 md:py-1.5 min-h-10 md:min-h-0 rounded-lg text-xs text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors"
        >
          <span>🧹</span>
          <span className="flex-1 text-left">Cleanup</span>
        </button>
      </div>
    </div>
  );
}
