import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  MarkerType,
  ReactFlowProvider,
  useReactFlow,
  type NodeTypes,
  type Edge,
  type Node,
  type NodeProps,
  type OnMove,
  type Viewport as RFViewport,
  Handle,
  Position,
} from "reactflow";
import dagre from "dagre";
import type { Workflow, TaskNode, TaskExecutionStatus } from "@minions/engine-next";
import { useWorkflowStore } from "../store/workflowStore.js";
import { useConnectionStore, type Connection } from "../connections/store.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { useApiMutation } from "../hooks/useApiMutation.js";
import { Modal } from "../components/Modal.js";
import { Button } from "../components/Button.js";
import { dispatchCommand } from "../transport/rest.js";
import { cx } from "../util/classnames.js";
import { PANEL_DAG_CANVAS, usePanelLayout, type Breakpoint } from "../util/panelLayout.js";
import { getViewport, setViewport, type Viewport } from "./dagViewport.js";
import { STATUS_DOT, STATUS_LABEL } from "./statusToVisual.js";
import "reactflow/dist/style.css";

const DAG_DEFAULT_WIDTH = 720;
const DAG_MIN_WIDTH = 320;
const DAG_MAX_WIDTH = 1600;

const STATUS_COLOR: Record<TaskExecutionStatus, string> = {
  pending: "border-border bg-bg-soft text-fg-muted",
  ready: "border-blue-400 bg-blue-100 text-blue-800 dark:border-blue-600 dark:bg-blue-950 dark:text-blue-300",
  running: "border-green-400 bg-green-100 text-green-800 dark:border-green-500 dark:bg-green-950 dark:text-green-300",
  finalizing: "border-teal-400 bg-teal-100 text-teal-800 dark:border-teal-600 dark:bg-teal-950 dark:text-teal-300",
  "quality-pending": "border-amber-400 bg-amber-100 text-amber-800 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-300",
  "ci-pending": "border-amber-400 bg-amber-100 text-amber-800 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-300",
  "pr-open": "border-indigo-400 bg-indigo-100 text-indigo-800 dark:border-indigo-500 dark:bg-indigo-950 dark:text-indigo-300",
  merged: "border-purple-400 bg-purple-100 text-purple-900 dark:border-purple-700 dark:bg-purple-950 dark:text-purple-200",
  "needs-review": "border-amber-400 bg-amber-100 text-amber-800 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-300",
  completed: "border-teal-400 bg-teal-100 text-teal-800 dark:border-teal-600 dark:bg-teal-950 dark:text-teal-300",
  failed: "border-red-400 bg-red-100 text-red-800 dark:border-red-500 dark:bg-red-950 dark:text-red-300",
  cancelled: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
};

const NODE_W = 180;
const NODE_H = 80;

interface DagNodeData {
  task: TaskNode;
  onRequestRetry?: (taskId: string) => void;
}

function isRetryable(status: TaskExecutionStatus): boolean {
  return status === "failed" || status === "cancelled";
}

function layoutWorkflow(
  workflow: Workflow,
  onRequestRetry?: (taskId: string) => void,
): { nodes: Node[]; edges: Edge[]; rootIds: string[] } {
  const tasks = Object.values(workflow.graph);
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", ranksep: 80, nodesep: 40 });

  for (const t of tasks) {
    g.setNode(t.id, { width: NODE_W, height: NODE_H });
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      g.setEdge(dep, t.id);
    }
  }

  dagre.layout(g);

  const nodes: Node[] = tasks.map((t) => {
    const pos = g.node(t.id);
    return {
      id: t.id,
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: { task: t, onRequestRetry } satisfies DagNodeData,
      type: "dagNode",
    };
  });

  const edges: Edge[] = [];
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      edges.push({
        id: `${dep}->${t.id}`,
        source: dep,
        target: t.id,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: "#4b5563" },
      });
    }
  }

  const rootIds = tasks
    .filter((t) => t.dependsOn.length === 0)
    .map((t) => t.id);

  return { nodes, edges, rootIds };
}

export function DagNodeComponent({ data }: NodeProps<DagNodeData>) {
  const { task, onRequestRetry } = data;
  const activeId = useConnectionStore((s) => s.activeId);
  const canRetry = isRetryable(task.executionStatus);
  const hasFailed = task.executionStatus === "failed";

  const goToSession = (taskId: string): void => {
    if (!activeId) return;
    const { view, query } = parseUrl();
    setUrlState({ connectionId: activeId, view, sessionSlug: taskId, query });
  };

  return (
    <div
      className={cx(
        "relative rounded-lg border px-3 py-2 text-xs cursor-default select-none",
        STATUS_COLOR[task.executionStatus],
      )}
      style={{ width: NODE_W }}
      data-testid="dag-node"
      data-node-id={task.id}
    >
      <Handle type="target" position={Position.Top} className="!bg-zinc-400 dark:!bg-zinc-600" />
      {hasFailed && (
        <span
          aria-label="task failed"
          data-testid="dag-node-attention-badge"
          title="Task failed"
          className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none border border-red-700 dark:border-red-300 shadow"
        >
          !
        </span>
      )}
      <div className="font-medium leading-tight line-clamp-2 break-words">{task.title}</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[10px] opacity-70">{STATUS_LABEL[task.executionStatus]}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        {task.sessionId && (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              goToSession(task.id);
            }}
            data-testid="dag-node-session-link"
            className="nodrag nopan text-[10px] underline opacity-60 hover:opacity-100 cursor-pointer"
          >
            view
          </button>
        )}
        {canRetry && onRequestRetry && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRequestRetry(task.id);
            }}
            className="text-[10px] px-1.5 py-0.5 rounded border border-red-400 bg-red-100/60 text-red-700 hover:bg-red-200/60 hover:text-red-800 dark:border-red-700 dark:bg-red-950/60 dark:text-red-300 dark:hover:bg-red-900/60 dark:hover:text-red-200"
          >
            retry
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-zinc-400 dark:!bg-zinc-600" />
    </div>
  );
}

const NODE_TYPES: NodeTypes = {
  dagNode: DagNodeComponent,
};

interface CanvasProps {
  workflow: Workflow;
  connectionId: string | null;
  breakpoint: Breakpoint;
}

function transitiveDescendants(workflow: Workflow, rootId: string): TaskNode[] {
  const tasks = Object.values(workflow.graph);
  const set = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (set.has(t.id)) continue;
      if (t.dependsOn.some((dep) => set.has(dep))) {
        set.add(t.id);
        changed = true;
      }
    }
  }
  set.delete(rootId);
  return tasks.filter((t) => set.has(t.id));
}

interface DagCanvasFlowProps {
  workflow: Workflow;
  nodes: Node[];
  edges: Edge[];
  defaultViewport: RFViewport | undefined;
  breakpoint: Breakpoint;
  onMove: OnMove;
  onNodeDoubleClick: (event: React.MouseEvent, node: Node) => void;
}

function DagCanvasFlow({
  workflow,
  nodes,
  edges,
  defaultViewport,
  breakpoint,
  onMove,
  onNodeDoubleClick,
}: DagCanvasFlowProps) {
  const rf = useReactFlow();
  const isMobile = breakpoint === "mobile";

  useEffect(() => {
    rf.fitView({ padding: 0.15, duration: 200 });
  }, [rf, workflow.id, breakpoint, nodes.length]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      fitView={isMobile ? undefined : !defaultViewport}
      defaultViewport={isMobile ? undefined : defaultViewport}
      onInit={(instance) => instance.fitView({ padding: 0.15, duration: 0 })}
      onMove={onMove}
      onNodeDoubleClick={onNodeDoubleClick}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#27272a" gap={20} />
      <Controls className="!bg-bg-elev !border-border" />
      <MiniMap className="!bg-bg-elev !border-border" nodeColor="#3f3f46" />
    </ReactFlow>
  );
}

function DagCanvasInner({ workflow, connectionId, breakpoint }: CanvasProps) {
  const conn = useConnectionStore((s) =>
    connectionId ? s.connections.find((c) => c.id === connectionId) ?? null : null,
  );

  const [retryFor, setRetryFor] = useState<string | null>(null);

  const retryMutation = useApiMutation<{ conn: Connection; workflowId: string; taskId: string }, unknown>(
    ({ conn: c, workflowId, taskId }) => dispatchCommand(c, {
      kind: "retry-task",
      workflowId,
      taskId,
      prompt: "",
    }),
    {
      onSuccess: () => {
        setRetryFor(null);
      },
    },
  );

  const { reset: resetRetryMutation, run: runRetryMutation } = retryMutation;

  const handleRequestRetry = useCallback(
    (taskId: string) => {
      resetRetryMutation();
      setRetryFor(taskId);
    },
    [resetRetryMutation],
  );

  const { nodes, edges } = useMemo(() => {
    return layoutWorkflow(workflow, handleRequestRetry);
  }, [workflow, handleRequestRetry]);

  const retryTask = useMemo(
    () => (retryFor ? workflow.graph[retryFor] ?? null : null),
    [workflow, retryFor],
  );
  const downstream = useMemo(
    () => (retryFor ? transitiveDescendants(workflow, retryFor) : []),
    [workflow, retryFor],
  );

  const closeRetryModal = useCallback(() => {
    setRetryFor(null);
    resetRetryMutation();
  }, [resetRetryMutation]);

  const handleConfirmRetry = useCallback(() => {
    if (!conn || !retryFor) return;
    void runRetryMutation({ conn, workflowId: workflow.id, taskId: retryFor });
  }, [conn, retryFor, workflow.id, runRetryMutation]);

  const stored = useMemo<Viewport | null>(() => {
    if (!connectionId) return null;
    return getViewport(connectionId, workflow.id);
  }, [connectionId, workflow.id]);

  const defaultViewport = useMemo<RFViewport | undefined>(() => {
    if (!stored) return undefined;
    return { x: stored.x, y: stored.y, zoom: stored.scale };
  }, [stored]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    };
  }, []);

  const handleMove = useCallback<OnMove>(
    (_event, viewport) => {
      if (!connectionId) return;
      if (breakpoint === "mobile") return;
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        setViewport(connectionId, workflow.id, {
          x: viewport.x,
          y: viewport.y,
          scale: viewport.zoom,
        });
      }, 200);
    },
    [connectionId, workflow.id, breakpoint],
  );

  const handleNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (!connectionId) return;
      const task = workflow.graph[node.id];
      if (!task) return;
      const { view, query } = parseUrl();
      setUrlState({ connectionId, view, sessionSlug: task.id, query });
    },
    [connectionId, workflow],
  );

  const downstreamPreview = downstream.slice(0, 5);
  const downstreamExtra = Math.max(0, downstream.length - downstreamPreview.length);

  return (
    <div className="w-full h-full">
      <ReactFlowProvider>
        <DagCanvasFlow
          workflow={workflow}
          nodes={nodes}
          edges={edges}
          defaultViewport={defaultViewport}
          breakpoint={breakpoint}
          onMove={handleMove}
          onNodeDoubleClick={handleNodeDoubleClick}
        />
      </ReactFlowProvider>
      <Modal
        open={retryTask !== null}
        onClose={closeRetryModal}
        title={retryTask ? `Retry "${retryTask.title}"?` : undefined}
      >
        {retryTask && (
          <div className="flex flex-col gap-4 text-sm">
            <div>
              {downstream.length === 0 ? (
                <div className="text-xs text-fg-muted">
                  No downstream tasks depend on this one.
                </div>
              ) : (
                <>
                  <div className="text-xs text-fg-muted mb-1">
                    Downstream tasks will be re-stacked against the new branch:
                  </div>
                  <ul className="list-disc pl-5 text-xs text-fg-muted space-y-0.5">
                    {downstreamPreview.map((t) => (
                      <li key={t.id} className="truncate">{t.title}</li>
                    ))}
                    {downstreamExtra > 0 && (
                      <li className="text-fg-subtle">+{downstreamExtra} more</li>
                    )}
                  </ul>
                </>
              )}
            </div>
            {retryMutation.error && (
              <div className="card p-2 text-xs text-err border border-err/30 bg-err/10">
                {retryMutation.error.message}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                onClick={closeRetryModal}
                disabled={retryMutation.loading}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleConfirmRetry}
                disabled={retryMutation.loading || !conn}
              >
                {retryMutation.loading ? "Retrying…" : "Retry"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

interface Props {
  sessionSlug?: string | null;
  dagId?: string;
}

interface DagCanvasChromeProps {
  children: ReactNode;
  breakpoint: Breakpoint;
  collapsed: boolean;
  toggleCollapsed: () => void;
}

function DagCanvasChrome({ children, breakpoint, collapsed, toggleCollapsed }: DagCanvasChromeProps) {
  const isMobile = breakpoint === "mobile";

  return (
    <div data-testid="panel-dag-canvas" className="flex flex-col h-full">
      {!isMobile && (
        <div
          data-testid="panel-dag-canvas-header"
          className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border bg-bg-soft text-xs"
        >
          <span className="text-fg-subtle font-medium">DAG canvas</span>
          <button
            type="button"
            onClick={toggleCollapsed}
            data-testid="panel-dag-canvas-toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand DAG canvas" : "Collapse DAG canvas"}
            className="text-fg-subtle hover:text-fg transition-colors"
          >
            {collapsed ? "▸" : "▾"}
          </button>
        </div>
      )}
      {(isMobile || !collapsed) && (
        <div
          data-testid="panel-dag-canvas-body"
          className="flex-1 min-w-0 min-h-0 overflow-hidden"
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function DagCanvasView({ dagId }: Props) {
  const activeId = useConnectionStore((s) => s.activeId);
  const workflowsMap = useWorkflowStore(
    (s) => (activeId ? s.byConnection.get(activeId) ?? new Map<string, Workflow>() : new Map<string, Workflow>()),
  );
  const workflows = useMemo(() => Array.from(workflowsMap.values()), [workflowsMap]);

  const { collapsed, breakpoint, toggleCollapsed } = usePanelLayout(
    PANEL_DAG_CANVAS,
    {
      defaultSize: DAG_DEFAULT_WIDTH,
      minSize: DAG_MIN_WIDTH,
      maxSize: DAG_MAX_WIDTH,
    },
  );

  const selectWorkflow = useCallback(
    (id: string) => {
      const { view, sessionSlug, query } = parseUrl();
      if (!activeId) return;
      setUrlState({ connectionId: activeId, view, sessionSlug, query: { ...query, dag: id } });
    },
    [activeId],
  );

  const clearWorkflow = useCallback(() => {
    const { view, sessionSlug, query } = parseUrl();
    if (!activeId) return;
    const { dag: _dag, ...rest } = query;
    void _dag;
    setUrlState({ connectionId: activeId, view, sessionSlug, query: rest });
  }, [activeId]);

  const selected = dagId ? workflows.find((w) => w.id === dagId) : undefined;

  if (!selected) {
    return (
      <DagCanvasChrome
        breakpoint={breakpoint}
        collapsed={collapsed}
        toggleCollapsed={toggleCollapsed}
      >
        <div className="p-6 overflow-y-auto">
          <h2 className="text-sm font-medium text-fg-muted mb-4">Select a workflow</h2>
          {workflows.length === 0 && (
            <p className="text-sm text-fg-subtle">No workflows available.</p>
          )}
          <div className="space-y-2">
            {workflows.map((w) => {
              const firstTask = Object.values(w.graph)[0];
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => selectWorkflow(w.id)}
                  className="w-full text-left card px-4 py-3 hover:border-border transition-colors"
                >
                  <div className="text-sm font-medium text-fg">{firstTask?.title ?? w.id}</div>
                  <div className="text-xs text-fg-subtle mt-0.5">
                    {w.id} · {w.status} · {Object.keys(w.graph).length} tasks
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </DagCanvasChrome>
    );
  }

  return (
    <DagCanvasChrome
      breakpoint={breakpoint}
      collapsed={collapsed}
      toggleCollapsed={toggleCollapsed}
    >
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-bg-soft text-xs md:text-sm md:px-4 md:py-2 md:gap-x-3">
          <button
            type="button"
            onClick={clearWorkflow}
            className="text-fg-subtle hover:text-fg-muted flex-shrink-0"
          >
            ← all workflows
          </button>
          <span className="text-fg font-medium truncate min-w-0 flex-1">
            {Object.values(selected.graph)[0]?.title ?? selected.id}
          </span>
          <span className="pill bg-bg-elev text-fg-muted text-[10px] flex-shrink-0">{selected.status}</span>
          <span className="text-fg-subtle text-[10px] md:text-xs flex-shrink-0">
            {Object.keys(selected.graph).length} tasks
          </span>
        </div>
        <div className="flex-1">
          <DagCanvasInner
            workflow={selected}
            connectionId={activeId}
            breakpoint={breakpoint}
          />
        </div>
      </div>
    </DagCanvasChrome>
  );
}
