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
import {
  isRetryableDagNodeStatus,
  type DAG,
  type DAGNode,
  type DAGNodeStatus,
  type DagNodeCiSummary,
} from "@minions/shared";
import { useDagStore, EMPTY_DAGS } from "../store/dagStore.js";
import { useSessionStore, EMPTY_SESSIONS } from "../store/sessionStore.js";
import { useConnectionStore, type Connection } from "../connections/store.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { useFeature } from "../hooks/useFeature.js";
import { useApiMutation } from "../hooks/useApiMutation.js";
import { UpgradeNotice } from "../components/UpgradeNotice.js";
import { Modal } from "../components/Modal.js";
import { Button } from "../components/Button.js";
import { retryDagNode } from "../transport/rest.js";
import { cx } from "../util/classnames.js";
import { PANEL_DAG_CANVAS, usePanelLayout, type Breakpoint } from "../util/panelLayout.js";
import { getViewport, setViewport, type Viewport } from "./dagViewport.js";
import "reactflow/dist/style.css";

const DAG_DEFAULT_WIDTH = 720;
const DAG_MIN_WIDTH = 320;
const DAG_MAX_WIDTH = 1600;

const STATUS_COLOR: Record<DAGNodeStatus, string> = {
  pending: "border-border bg-bg-soft text-fg-muted",
  ready: "border-blue-600 bg-blue-950 text-blue-300",
  running: "border-green-500 bg-green-950 text-green-300",
  done: "border-teal-600 bg-teal-950 text-teal-300",
  failed: "border-red-500 bg-red-950 text-red-300",
  skipped: "border-border bg-bg-elev text-fg-subtle",
  "ci-pending": "border-amber-500 bg-amber-950 text-amber-300",
  "ci-failed": "border-orange-500 bg-orange-950 text-orange-300",
  landed: "border-purple-600 bg-purple-950 text-purple-300",
  rebasing: "border-yellow-500 bg-yellow-950 text-yellow-300",
  "rebase-conflict": "border-red-700 bg-red-950 text-red-400",
  cancelled: "border-zinc-600 bg-zinc-900 text-zinc-400",
};

const NODE_W = 180;
const NODE_H = 80;
const PARENT_NODE_ID = "__parent__";

const CI_PILL_CLASS: Record<DagNodeCiSummary["state"], string> = {
  passing: "border-green-700 bg-green-950/70 text-green-300",
  failing: "border-red-700 bg-red-950/70 text-red-300",
  pending: "border-zinc-600 bg-zinc-900/70 text-zinc-300",
};

const CI_PILL_LABEL: Record<DagNodeCiSummary["state"], string> = {
  passing: "CI passing",
  failing: "CI failing",
  pending: "CI pending",
};

function ciTooltip(summary: DagNodeCiSummary): string {
  const header = `${CI_PILL_LABEL[summary.state]} — ${summary.counts.passed} pass / ${summary.counts.failed} fail / ${summary.counts.pending} pending`;
  if (summary.checks.length === 0) return header;
  const lines = summary.checks
    .slice(0, 12)
    .map((c) => `• ${c.name || "(unnamed)"} [${c.bucket}]`);
  if (summary.checks.length > 12) {
    lines.push(`… +${summary.checks.length - 12} more`);
  }
  return `${header}\n${lines.join("\n")}`;
}

function CiStatusPill({ summary }: { summary: DagNodeCiSummary }) {
  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (!summary.prUrl) return;
    window.open(summary.prUrl, "_blank", "noopener,noreferrer");
  };
  const clickable = !!summary.prUrl;
  const dot =
    summary.state === "passing"
      ? "bg-green-400"
      : summary.state === "failing"
        ? "bg-red-400"
        : "bg-zinc-400";
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!clickable}
      title={ciTooltip(summary)}
      data-testid="dag-node-ci-pill"
      data-ci-state={summary.state}
      className={cx(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] leading-none",
        CI_PILL_CLASS[summary.state],
        clickable ? "cursor-pointer hover:brightness-125" : "cursor-default opacity-80",
      )}
    >
      <span className={cx("inline-block w-1.5 h-1.5 rounded-full", dot)} />
      <span>CI</span>
      {summary.counts.failed > 0 && (
        <span className="font-semibold">{summary.counts.failed}✗</span>
      )}
      {summary.counts.failed === 0 && summary.counts.pending > 0 && (
        <span className="font-semibold">{summary.counts.pending}…</span>
      )}
    </button>
  );
}

interface DagNodeData {
  node: DAGNode;
  onRequestRetry?: (nodeId: string) => void;
}

interface ParentNodeData {
  sessionSlug: string;
  parentDagId: string | null;
}

function layoutDag(
  dag: DAG,
  onRequestRetry?: (nodeId: string) => void,
): { nodes: Node[]; edges: Edge[]; rootIds: string[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", ranksep: 80, nodesep: 40 });

  for (const n of dag.nodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H });
  }
  for (const n of dag.nodes) {
    for (const dep of n.dependsOn) {
      g.setEdge(dep, n.id);
    }
  }

  dagre.layout(g);

  const nodes: Node[] = dag.nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: { node: n, onRequestRetry } satisfies DagNodeData,
      type: "dagNode",
    };
  });

  const edges: Edge[] = [];
  for (const n of dag.nodes) {
    for (const dep of n.dependsOn) {
      edges.push({
        id: `${dep}->${n.id}`,
        source: dep,
        target: n.id,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: "#4b5563" },
      });
    }
  }

  const rootIds = dag.nodes
    .filter((n) => n.dependsOn.length === 0)
    .map((n) => n.id);

  return { nodes, edges, rootIds };
}

function findParentDagId(
  dags: Iterable<DAG>,
  parentSlug: string,
  excludeDagId: string,
): string | null {
  for (const d of dags) {
    if (d.id === excludeDagId) continue;
    if (d.rootSessionSlug === parentSlug) return d.id;
    if (d.nodes.some((n) => n.sessionSlug === parentSlug)) return d.id;
  }
  return null;
}

export function DagNodeComponent({ data }: NodeProps<DagNodeData>) {
  const { node, onRequestRetry } = data;
  const activeId = useConnectionStore((s) => s.activeId);
  const hasAttention = useSessionStore((s) => {
    if (!node.sessionSlug || !activeId) return false;
    const sessions = s.byConnection.get(activeId)?.sessions ?? EMPTY_SESSIONS;
    const session = sessions.get(node.sessionSlug);
    return !!session && session.attention.length > 0;
  });
  const hasCiFailedAttention = useSessionStore((s) => {
    if (!node.sessionSlug || !activeId) return false;
    const sessions = s.byConnection.get(activeId)?.sessions ?? EMPTY_SESSIONS;
    const session = sessions.get(node.sessionSlug);
    return !!session && session.attention.some((a) => a.kind === "ci_failed");
  });
  const showAttention = hasAttention || node.status === "failed";
  const canRetry = isRetryableDagNodeStatus(node.status);
  const ciSummary = node.ciSummary ?? null;

  const goToSession = (slug: string): void => {
    if (!activeId) return;
    const { view, query } = parseUrl();
    setUrlState({ connectionId: activeId, view, sessionSlug: slug, query });
  };

  return (
    <div
      className={cx(
        "relative rounded-lg border px-3 py-2 text-xs cursor-default select-none",
        STATUS_COLOR[node.status],
      )}
      style={{ width: NODE_W }}
      data-testid="dag-node"
      data-node-id={node.id}
    >
      <Handle type="target" position={Position.Top} className="!bg-zinc-600" />
      {showAttention && (
        <span
          aria-label={hasCiFailedAttention ? "CI failed" : "needs attention"}
          data-testid="dag-node-attention-badge"
          data-ci-failed={hasCiFailedAttention ? "true" : "false"}
          title={
            hasCiFailedAttention
              ? "CI failed — session flagged for attention"
              : node.status === "failed"
                ? "node failed"
                : "session has attention flags"
          }
          className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none border border-red-300 shadow"
        >
          !
        </span>
      )}
      <div className="font-medium leading-tight line-clamp-2 break-words">{node.title}</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[10px] opacity-70">{node.status}</span>
        {ciSummary && <CiStatusPill summary={ciSummary} />}
      </div>
      <div className="mt-1 flex items-center gap-2">
        {node.sessionSlug && (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (node.sessionSlug) goToSession(node.sessionSlug);
            }}
            data-testid="dag-node-session-link"
            className="nodrag nopan text-[10px] underline opacity-60 hover:opacity-100 cursor-pointer"
          >
            {node.sessionSlug}
          </button>
        )}
        {canRetry && onRequestRetry && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRequestRetry(node.id);
            }}
            className="text-[10px] px-1.5 py-0.5 rounded border border-red-700 bg-red-950/60 text-red-300 hover:bg-red-900/60 hover:text-red-200"
          >
            retry
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600" />
    </div>
  );
}

function ParentNodeComponent({ data }: NodeProps<ParentNodeData>) {
  const target = data.parentDagId ? "open parent DAG" : "open parent session";
  return (
    <div
      className="rounded-lg border border-dashed border-fg-subtle bg-bg-elev px-3 py-2 text-xs text-fg-muted cursor-pointer select-none"
      style={{ width: NODE_W }}
      title={`double-click to ${target}`}
    >
      <div className="text-[10px] uppercase tracking-wide opacity-60">parent</div>
      <div className="font-medium leading-tight line-clamp-2 break-words">{data.sessionSlug}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600" />
    </div>
  );
}

const NODE_TYPES: NodeTypes = {
  dagNode: DagNodeComponent,
  parentRef: ParentNodeComponent,
};

interface CanvasProps {
  dag: DAG;
  connectionId: string | null;
  onSelectDag: (id: string) => void;
  breakpoint: Breakpoint;
}

function transitiveDescendants(dag: DAG, rootId: string): DAGNode[] {
  const set = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of dag.nodes) {
      if (set.has(n.id)) continue;
      if (n.dependsOn.some((dep) => set.has(dep))) {
        set.add(n.id);
        changed = true;
      }
    }
  }
  set.delete(rootId);
  return dag.nodes.filter((n) => set.has(n.id));
}

interface DagCanvasFlowProps {
  dag: DAG;
  nodes: Node[];
  edges: Edge[];
  defaultViewport: RFViewport | undefined;
  breakpoint: Breakpoint;
  onMove: OnMove;
  onNodeDoubleClick: (event: React.MouseEvent, node: Node) => void;
}

function DagCanvasFlow({
  dag,
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
  }, [rf, dag.id, breakpoint, nodes.length]);

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

function DagCanvasInner({ dag, connectionId, onSelectDag, breakpoint }: CanvasProps) {
  const dagsMap = useDagStore(
    (s) => (connectionId ? s.byConnection.get(connectionId) ?? EMPTY_DAGS : EMPTY_DAGS),
  );
  const conn = useConnectionStore((s) =>
    connectionId ? s.connections.find((c) => c.id === connectionId) ?? null : null,
  );

  const [retryFor, setRetryFor] = useState<string | null>(null);

  const retryMutation = useApiMutation<{ conn: Connection; dagId: string; nodeId: string }, DAG>(
    ({ conn: c, dagId, nodeId }) => retryDagNode(c, dagId, nodeId),
    {
      onSuccess: () => {
        setRetryFor(null);
      },
    },
  );
  const { reset: resetRetryMutation, run: runRetryMutation } = retryMutation;

  const handleRequestRetry = useCallback(
    (nodeId: string) => {
      resetRetryMutation();
      setRetryFor(nodeId);
    },
    [resetRetryMutation],
  );

  const { nodes, edges } = useMemo(() => {
    const { nodes: baseNodes, edges: baseEdges, rootIds } = layoutDag(dag, handleRequestRetry);

    if (!dag.rootSessionSlug) {
      return { nodes: baseNodes, edges: baseEdges };
    }

    const parentDagId = findParentDagId(
      dagsMap.values(),
      dag.rootSessionSlug,
      dag.id,
    );

    const minRootX = baseNodes.length
      ? Math.min(...baseNodes.map((n) => n.position.x))
      : 0;
    const maxRootX = baseNodes.length
      ? Math.max(...baseNodes.map((n) => n.position.x + NODE_W))
      : NODE_W;
    const centerX = (minRootX + maxRootX) / 2 - NODE_W / 2;
    const topY = baseNodes.length
      ? Math.min(...baseNodes.map((n) => n.position.y))
      : 0;

    const parentNode: Node = {
      id: PARENT_NODE_ID,
      position: { x: centerX, y: topY - NODE_H - 80 },
      data: {
        sessionSlug: dag.rootSessionSlug,
        parentDagId,
      } satisfies ParentNodeData,
      type: "parentRef",
      draggable: false,
      selectable: false,
    };

    const parentEdges: Edge[] = rootIds.map((rootId) => ({
      id: `${PARENT_NODE_ID}->${rootId}`,
      source: PARENT_NODE_ID,
      target: rootId,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "#a78bfa", strokeDasharray: "4 4" },
    }));

    return {
      nodes: [parentNode, ...baseNodes],
      edges: [...baseEdges, ...parentEdges],
    };
  }, [dag, dagsMap, handleRequestRetry]);

  const retryNode = useMemo(
    () => (retryFor ? dag.nodes.find((n) => n.id === retryFor) ?? null : null),
    [dag, retryFor],
  );
  const downstream = useMemo(
    () => (retryFor ? transitiveDescendants(dag, retryFor) : []),
    [dag, retryFor],
  );

  const closeRetryModal = useCallback(() => {
    setRetryFor(null);
    resetRetryMutation();
  }, [resetRetryMutation]);

  const handleConfirmRetry = useCallback(() => {
    if (!conn || !retryFor) return;
    void runRetryMutation({ conn, dagId: dag.id, nodeId: retryFor });
  }, [conn, retryFor, dag.id, runRetryMutation]);

  const stored = useMemo<Viewport | null>(() => {
    if (!connectionId) return null;
    return getViewport(connectionId, dag.id);
  }, [connectionId, dag.id]);

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
        setViewport(connectionId, dag.id, {
          x: viewport.x,
          y: viewport.y,
          scale: viewport.zoom,
        });
      }, 200);
    },
    [connectionId, dag.id, breakpoint],
  );

  const handleNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.id !== PARENT_NODE_ID) return;
      const data = node.data as ParentNodeData;
      if (data.parentDagId) {
        onSelectDag(data.parentDagId);
        return;
      }
      if (!connectionId) return;
      const { view, query } = parseUrl();
      setUrlState({
        connectionId,
        view,
        sessionSlug: data.sessionSlug,
        query,
      });
    },
    [connectionId, onSelectDag],
  );

  const downstreamPreview = downstream.slice(0, 5);
  const downstreamExtra = Math.max(0, downstream.length - downstreamPreview.length);

  return (
    <div className="w-full h-full">
      <ReactFlowProvider>
        <DagCanvasFlow
          dag={dag}
          nodes={nodes}
          edges={edges}
          defaultViewport={defaultViewport}
          breakpoint={breakpoint}
          onMove={handleMove}
          onNodeDoubleClick={handleNodeDoubleClick}
        />
      </ReactFlowProvider>
      <Modal
        open={retryNode !== null}
        onClose={closeRetryModal}
        title={retryNode ? `Retry node "${retryNode.title}"?` : undefined}
      >
        {retryNode && (
          <div className="flex flex-col gap-4 text-sm">
            <div>
              <div className="text-xs text-fg-subtle mb-1">Failure reason:</div>
              <pre className="card p-2 text-xs whitespace-pre-wrap break-words max-h-40 overflow-auto">
                {retryNode.failedReason ?? "(none recorded)"}
              </pre>
            </div>
            <div>
              {downstream.length === 0 ? (
                <div className="text-xs text-fg-muted">
                  No downstream nodes depend on this one.
                </div>
              ) : (
                <>
                  <div className="text-xs text-fg-muted mb-1">
                    Downstream nodes will be re-stacked against the new branch:
                  </div>
                  <ul className="list-disc pl-5 text-xs text-fg-muted space-y-0.5">
                    {downstreamPreview.map((n) => (
                      <li key={n.id} className="truncate">{n.title}</li>
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
  const enabled = useFeature("dags");
  const activeId = useConnectionStore((s) => s.activeId);
  const dagsMap = useDagStore(
    (s) => (activeId ? s.byConnection.get(activeId) ?? EMPTY_DAGS : EMPTY_DAGS),
  );
  const dags = useMemo(() => Array.from(dagsMap.values()), [dagsMap]);

  const { collapsed, breakpoint, toggleCollapsed } = usePanelLayout(
    PANEL_DAG_CANVAS,
    {
      defaultSize: DAG_DEFAULT_WIDTH,
      minSize: DAG_MIN_WIDTH,
      maxSize: DAG_MAX_WIDTH,
    },
  );

  const selectDag = useCallback(
    (id: string) => {
      const { view, sessionSlug, query } = parseUrl();
      if (!activeId) return;
      setUrlState({ connectionId: activeId, view, sessionSlug, query: { ...query, dag: id } });
    },
    [activeId],
  );

  const clearDag = useCallback(() => {
    const { view, sessionSlug, query } = parseUrl();
    if (!activeId) return;
    const { dag: _dag, ...rest } = query;
    void _dag;
    setUrlState({ connectionId: activeId, view, sessionSlug, query: rest });
  }, [activeId]);

  if (!enabled) return <UpgradeNotice feature="dags" />;

  const selected = dagId ? dags.find((d) => d.id === dagId) : undefined;

  if (!selected) {
    return (
      <DagCanvasChrome
        breakpoint={breakpoint}
        collapsed={collapsed}
        toggleCollapsed={toggleCollapsed}
      >
        <div className="p-6 overflow-y-auto">
          <h2 className="text-sm font-medium text-fg-muted mb-4">Select a DAG</h2>
          {dags.length === 0 && (
            <p className="text-sm text-fg-subtle">No DAGs available.</p>
          )}
          <div className="space-y-2">
            {dags.map((dag) => (
              <button
                key={dag.id}
                type="button"
                onClick={() => selectDag(dag.id)}
                className="w-full text-left card px-4 py-3 hover:border-border transition-colors"
              >
                <div className="text-sm font-medium text-fg">{dag.title}</div>
                <div className="text-xs text-fg-subtle mt-0.5">
                  {dag.id} · {dag.status} · {dag.nodes.length} nodes
                </div>
              </button>
            ))}
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
            onClick={clearDag}
            className="text-fg-subtle hover:text-fg-muted flex-shrink-0"
          >
            ← all DAGs
          </button>
          <span className="text-fg font-medium truncate min-w-0 flex-1">{selected.title}</span>
          <span className="pill bg-bg-elev text-fg-muted text-[10px] flex-shrink-0">{selected.status}</span>
          <span className="text-fg-subtle text-[10px] md:text-xs flex-shrink-0">{selected.nodes.length} nodes</span>
        </div>
        <div className="flex-1">
          <DagCanvasInner
            dag={selected}
            connectionId={activeId}
            onSelectDag={selectDag}
            breakpoint={breakpoint}
          />
        </div>
      </div>
    </DagCanvasChrome>
  );
}
