import { useMemo, type ReactElement } from "react";
import { useConnectionStore } from "../connections/store.js";
import { useVersionStore } from "../store/version.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl, type ViewKind } from "../routing/parseUrl.js";
import { cx } from "../util/classnames.js";

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed";
type FilterMode = "all" | "task" | "ship" | "dag-task" | "loop";

interface SidebarProps {
  currentView: ViewKind;
  filterStatus: FilterStatus;
  filterMode: FilterMode;
  onFilterStatus: (v: FilterStatus) => void;
  onFilterMode: (v: FilterMode) => void;
  onOpenAudit: () => void;
  onOpenMemory: () => void;
  onOpenRuntime: () => void;
  onOpenLoops: () => void;
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
];

const STATUS_FILTERS: { value: FilterStatus; label: string }[] = [
  { value: "all", label: "All" },
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

export function Sidebar({
  currentView,
  filterStatus,
  filterMode,
  onFilterStatus,
  onFilterMode,
  onOpenAudit,
  onOpenMemory,
  onOpenRuntime,
  onOpenLoops,
  onNavigate,
}: SidebarProps): ReactElement {
  const activeId = useConnectionStore(s => s.activeId);
  const featureList = useVersionStore(s => (activeId ? s.byConnection.get(activeId)?.features : undefined));
  const features = useMemo(() => new Set<string>(featureList ?? []), [featureList]);

  function navigate(view: ViewKind): void {
    if (!activeId) return;
    const { sessionSlug, query } = parseUrl();
    setUrlState({ connectionId: activeId, view, sessionSlug, query });
    onNavigate?.();
  }

  return (
    <div className="flex flex-col h-full py-2 gap-1">
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
              "w-full text-left px-2 py-1 rounded text-xs transition-colors",
              filterStatus === f.value
                ? "text-fg bg-bg-elev"
                : "text-fg-subtle hover:text-fg-muted",
            )}
          >
            {f.label}
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
              "w-full text-left px-2 py-1 rounded text-xs transition-colors",
              filterMode === f.value
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
          <button onClick={onOpenLoops} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors">
            <span>↺</span> Loops
          </button>
        )}
        {features.has("memory") && (
          <button onClick={onOpenMemory} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors">
            <span>🧠</span> Memory
          </button>
        )}
        {features.has("runtime-overrides") && (
          <button onClick={onOpenRuntime} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors">
            <span>⚙</span> Runtime
          </button>
        )}
        {features.has("audit") && (
          <button onClick={onOpenAudit} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors">
            <span>📋</span> Audit
          </button>
        )}
      </div>
    </div>
  );
}
