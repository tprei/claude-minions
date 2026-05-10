import { useState, useMemo, useRef, useCallback } from "react";
import type { Workflow, TaskNode, TaskExecutionStatus } from "@minions/engine";
import { useWorkflowStore, EMPTY_WORKFLOWS } from "../store/workflowStore.js";
import { useConnectionStore, type Connection } from "../connections/store.js";
import { useRootStore } from "../store/root.js";
import { refetchConnection } from "../store/connectionState.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { relTime } from "../util/time.js";
import { cx } from "../util/classnames.js";
import { SessionActionsMenu } from "../chat/SessionActionsMenu.js";
import { usePullToRefresh } from "../pwa/gestures.js";
import { Spinner } from "../components/Spinner.js";
import { RepoTabs } from "./RepoTabs.js";
import { STATUS_DOT, STATUS_LABEL, isRunning, isWaiting, isCompleted, isFailed } from "./statusToVisual.js";

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed";
type FilterMode = "all" | "task" | "dag-task";

const ALL_STATUSES: TaskExecutionStatus[] = [
  "pending", "ready", "running", "finalizing", "quality-pending", "ci-pending",
  "pr-open", "merged", "needs-review", "completed", "failed", "cancelled",
];

function toggleSet<T>(set: Set<T>, val: T): Set<T> {
  const next = new Set(set);
  if (next.has(val)) next.delete(val);
  else next.add(val);
  return next;
}

/** A flat row for the list view derived from a workflow + task pair. */
interface WorkflowTaskRow {
  workflowId: string;
  taskId: string;
  title: string;
  prompt: string;
  status: TaskExecutionStatus;
  updatedAt: string;
  createdAt: string;
  kind: string;
  workflow: Workflow;
  task: TaskNode;
}

interface Props {
  filterStatus?: FilterStatus;
  filterMode?: FilterMode;
  filterRepo: string | null;
  onFilterRepo: (repoId: string | null) => void;
}

export function ListView({ filterStatus = "all", filterMode = "all", filterRepo, onFilterRepo }: Props) {
  const activeId = useConnectionStore((s) => s.activeId);
  const conn = useRootStore((s) => s.getActiveConnection());
  const workflowsMap = useWorkflowStore(
    (s) => (activeId ? s.byConnection.get(activeId) ?? EMPTY_WORKFLOWS : EMPTY_WORKFLOWS),
  );
  const [statusFilter, setStatusFilter] = useState<Set<TaskExecutionStatus>>(new Set());
  const [search, setSearch] = useState("");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const onRefresh = useCallback(async () => {
    if (!conn) return;
    await refetchConnection(conn);
  }, [conn]);

  const pull = usePullToRefresh(scrollRef, onRefresh);

  const rows = useMemo<WorkflowTaskRow[]>(() => {
    const result: WorkflowTaskRow[] = [];
    for (const workflow of workflowsMap.values()) {
      for (const task of Object.values(workflow.graph)) {
        result.push({
          workflowId: workflow.id,
          taskId: task.id,
          title: task.title,
          prompt: task.prompt,
          status: task.executionStatus,
          updatedAt: task.updatedAt,
          createdAt: task.createdAt,
          kind: workflow.kind,
          workflow,
          task,
        });
      }
    }
    return result;
  }, [workflowsMap]);

  const filtered = useMemo(() => {
    const cmp = (a: WorkflowTaskRow, b: WorkflowTaskRow) =>
      new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    let list = [...rows].sort((a, b) => (sortDir === "desc" ? cmp(b, a) : cmp(a, b)));

    if (filterStatus === "running") {
      list = list.filter((r) => isRunning(r.status));
    } else if (filterStatus === "waiting_input") {
      list = list.filter((r) => isWaiting(r.status));
    } else if (filterStatus === "completed") {
      list = list.filter((r) => isCompleted(r.status));
    } else if (filterStatus === "failed") {
      list = list.filter((r) => isFailed(r.status));
    }

    if (filterMode === "task") {
      list = list.filter((r) => r.kind === "single-task" || r.kind === "think-thread");
    } else if (filterMode === "dag-task") {
      list = list.filter((r) => r.kind === "manual-dag" || r.kind === "ship");
    }

    if (statusFilter.size > 0) {
      list = list.filter((r) => statusFilter.has(r.status));
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.prompt.toLowerCase().includes(q),
      );
    }
    return list;
  }, [rows, filterStatus, filterMode, filterRepo, statusFilter, search, sortDir]);

  const navigate = (taskId: string) => {
    const { query } = parseUrl();
    if (!activeId) return;
    setUrlState({ connectionId: activeId, view: "list", sessionSlug: taskId, query });
  };

  const navigateToDag = (workflowId: string) => {
    if (!activeId) return;
    const { query, sessionSlug } = parseUrl();
    setUrlState({ connectionId: activeId, view: "dag", sessionSlug, query: { ...query, dag: workflowId } });
  };

  return (
    <div className="flex flex-col h-full">
      <RepoTabs filterRepo={filterRepo} onFilterRepo={onFilterRepo} />
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border bg-bg-soft">
        <input
          type="search"
          placeholder="Search tasks…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input w-52"
        />
        <div className="flex flex-wrap gap-1">
          {ALL_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter((f) => toggleSet(f, s))}
              className={cx(
                "pill text-xs cursor-pointer border",
                statusFilter.has(s)
                  ? "bg-accent text-white border-accent"
                  : "bg-bg-elev text-fg-muted border-border",
              )}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")}
          className="pill text-xs cursor-pointer border bg-bg-elev text-fg-muted border-border"
        >
          {sortDir === "desc" ? "newest first" : "oldest first"}
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto relative">
        <div
          aria-hidden={!pull.refreshing && !pull.dragging}
          className={cx(
            "absolute top-0 left-0 right-0 flex justify-center pointer-events-none z-10",
            !pull.dragging && "transition-transform duration-200",
          )}
          style={{
            transform: `translateY(${pull.dragging ? pull.offset - 32 : pull.refreshing ? 8 : -32}px)`,
          }}
        >
          <span
            className={cx(
              "rounded-full border shadow p-1.5",
              pull.progress >= 1 ? "bg-accent text-white border-accent" : "bg-bg-soft border-border",
            )}
          >
            <Spinner size="sm" />
          </span>
        </div>
        {filtered.length === 0 ? (
          <EmptyState filterStatus={filterStatus} />
        ) : (
          <>
            <table className="w-full text-sm hidden sm:table">
              <thead className="sticky top-0 bg-bg-soft border-b border-border text-xs text-fg-subtle">
                <tr>
                  <th className="text-left px-4 py-2 font-normal">title</th>
                  <th className="text-left px-4 py-2 font-normal">type</th>
                  <th className="text-left px-4 py-2 font-normal">status</th>
                  <th
                    className="text-left px-4 py-2 font-normal cursor-pointer hover:text-fg"
                    onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")}
                  >
                    updated {sortDir === "desc" ? "↓" : "↑"}
                  </th>
                  <th className="px-4 py-2 font-normal">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <TaskRow
                    key={`${row.workflowId}/${row.taskId}`}
                    row={row}
                    conn={conn}
                    onClick={() => navigate(row.taskId)}
                    onOpenDag={navigateToDag}
                  />
                ))}
              </tbody>
            </table>
            <div className="block sm:hidden p-2 space-y-2">
              {filtered.map((row) => (
                <TaskCard
                  key={`${row.workflowId}/${row.taskId}`}
                  row={row}
                  conn={conn}
                  onClick={() => navigate(row.taskId)}
                  onOpenDag={navigateToDag}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  row: WorkflowTaskRow;
  conn: Connection | null;
  onClick: () => void;
  onOpenDag: (workflowId: string) => void;
}

function EmptyState({ filterStatus }: { filterStatus: FilterStatus }) {
  return (
    <div className="text-sm text-fg-subtle text-center mt-16">
      {filterStatus === "all"
        ? "No tasks yet. Create a new session to get started."
        : "No tasks match these filters."}
    </div>
  );
}

function KindPill({ kind }: { kind: string }) {
  const label =
    kind === "single-task" ? "task"
    : kind === "think-thread" ? "think"
    : kind === "ship" ? "ship"
    : kind === "loop" ? "loop"
    : kind === "manual-dag" ? "dag"
    : kind;
  const color =
    kind === "single-task" ? "bg-blue-900 text-blue-300"
    : kind === "think-thread" ? "bg-violet-900 text-violet-300"
    : kind === "ship" ? "bg-orange-900 text-orange-300"
    : kind === "loop" ? "bg-green-900 text-green-300"
    : "bg-indigo-900 text-indigo-300";
  return <span className={cx("pill text-[10px]", color)}>{label}</span>;
}

function DagPill({ workflowId, onOpen }: { workflowId: string; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(workflowId); }}
      title="Open DAG view"
      className="pill bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300 text-[10px] cursor-pointer hover:bg-indigo-200 dark:hover:bg-indigo-900/60 transition-colors"
    >
      DAG
    </button>
  );
}

function TaskCard({ row, conn, onClick, onOpenDag }: RowProps) {
  const isMultiTask = Object.keys(row.workflow.graph).length > 1;
  return (
    <div
      onClick={onClick}
      className="card p-3 cursor-pointer hover:border-border transition-colors space-y-2"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-fg leading-snug line-clamp-2">{row.title}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {conn && <SessionActionsMenu workflow={row.workflow} conn={conn} />}
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <KindPill kind={row.kind} />
        {isMultiTask && <DagPill workflowId={row.workflowId} onOpen={onOpenDag} />}
        <span className="inline-flex items-center gap-1.5 pill bg-bg-elev text-fg-muted text-[10px]">
          <span className={cx("w-2 h-2 rounded-full", STATUS_DOT[row.status])} />
          {STATUS_LABEL[row.status]}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-fg-subtle">
        <span>{relTime(row.updatedAt)}</span>
      </div>
    </div>
  );
}

function TaskRow({ row, conn, onClick, onOpenDag }: RowProps) {
  const isMultiTask = Object.keys(row.workflow.graph).length > 1;
  return (
    <tr
      onClick={onClick}
      className="border-b border-border/50 hover:bg-bg-elev cursor-pointer transition-colors"
    >
      <td className="px-4 py-2 max-w-xs truncate text-fg">{row.title}</td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <KindPill kind={row.kind} />
          {isMultiTask && <DagPill workflowId={row.workflowId} onOpen={onOpenDag} />}
        </div>
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1.5">
          <span className={cx("w-2 h-2 rounded-full shrink-0", STATUS_DOT[row.status])} />
          <span className="text-fg-muted text-xs">{STATUS_LABEL[row.status]}</span>
        </div>
      </td>
      <td className="px-4 py-2 text-fg-subtle text-xs whitespace-nowrap">
        {relTime(row.updatedAt)}
      </td>
      <td className="px-4 py-2 text-right whitespace-nowrap">
        {conn && <SessionActionsMenu workflow={row.workflow} conn={conn} />}
      </td>
    </tr>
  );
}
