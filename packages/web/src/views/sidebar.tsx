import { useMemo, type ReactElement } from "react";
import { useConnectionStore } from "../connections/store.js";
import { useWorkflowStore, EMPTY_WORKFLOWS } from "../store/workflowStore.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl, type ViewKind } from "../routing/parseUrl.js";
import { cx } from "../util/classnames.js";
import { isRunning, isWaiting, isCompleted, isFailed } from "./statusToVisual.js";

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed";
type FilterMode = "all" | "task" | "dag-task";

interface SidebarProps {
  currentView: ViewKind;
  filterStatus: FilterStatus;
  filterMode: FilterMode;
  onFilterStatus: (v: FilterStatus) => void;
  onFilterMode: (v: FilterMode) => void;
  onNavigate?: () => void;
}

interface ViewOption {
  id: ViewKind;
  label: string;
  icon: string;
}

const VIEW_OPTIONS: ViewOption[] = [
  { id: "list", label: "List", icon: "≡" },
  { id: "dag", label: "DAG", icon: "⬡" },
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
  { value: "dag-task", label: "DAG task" },
];

export function Sidebar({
  currentView,
  filterStatus,
  filterMode,
  onFilterStatus,
  onFilterMode,
  onNavigate,
}: SidebarProps): ReactElement {
  const activeId = useConnectionStore(s => s.activeId);
  const workflowsMap = useWorkflowStore(s =>
    activeId ? s.byConnection.get(activeId) ?? EMPTY_WORKFLOWS : EMPTY_WORKFLOWS,
  );

  const statusCounts = useMemo<Record<FilterStatus, number>>(() => {
    const counts: Record<FilterStatus, number> = {
      all: 0,
      running: 0,
      waiting_input: 0,
      completed: 0,
      failed: 0,
    };
    for (const workflow of workflowsMap.values()) {
      for (const task of Object.values(workflow.graph)) {
        counts.all++;
        if (isRunning(task.executionStatus)) counts.running++;
        else if (isWaiting(task.executionStatus)) counts.waiting_input++;
        else if (isCompleted(task.executionStatus)) counts.completed++;
        else if (isFailed(task.executionStatus)) counts.failed++;
      }
    }
    return counts;
  }, [workflowsMap]);

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
        {VIEW_OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => navigate(opt.id)}
            className={cx(
              "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors text-left",
              currentView === opt.id
                ? "bg-accent/20 text-fg"
                : "text-fg-muted hover:text-fg hover:bg-bg-elev",
            )}
          >
            <span className="text-base w-5 text-center leading-none">{opt.icon}</span>
            {opt.label}
          </button>
        ))}
      </div>

      <div className="border-t border-border mx-2 my-1" />

      <div className="px-2">
        <p className="text-xs text-fg-subtle uppercase tracking-wider px-2 py-1">Status</p>
        {STATUS_FILTERS.map(f => {
          const count = statusCounts[f.value];
          const isActive = filterStatus === f.value;
          const emphasize =
            !isActive && count > 0 && (f.value === "waiting_input" || f.value === "failed");
          return (
            <button
              key={f.value}
              onClick={() => onFilterStatus(f.value)}
              className={cx(
                "w-full flex items-center justify-between gap-2 text-left px-2 py-2 md:py-1 min-h-10 md:min-h-0 rounded text-xs transition-colors",
                isActive ? "text-fg bg-bg-elev" : "text-fg-subtle hover:text-fg-muted",
              )}
            >
              <span>{f.label}</span>
              <span
                className={cx(
                  "tabular-nums text-[10px] px-1.5 py-0.5 rounded",
                  count === 0
                    ? "text-fg-subtle/60"
                    : emphasize
                      ? f.value === "failed"
                        ? "text-red-300 bg-red-900/40"
                        : "text-amber-300 bg-amber-900/30"
                      : isActive
                        ? "text-fg bg-bg"
                        : "text-fg-muted bg-bg-elev/60",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
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

      <div className="flex-1" />
    </div>
  );
}
