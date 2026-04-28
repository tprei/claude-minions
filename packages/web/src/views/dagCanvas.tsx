import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  MarkerType,
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
import type { DAG, DAGNode, DAGNodeStatus } from "@minions/shared";
import { useDagStore, EMPTY_DAGS } from "../store/dagStore.js";
import { useSessionStore, EMPTY_SESSIONS } from "../store/sessionStore.js";
import { useConnectionStore } from "../connections/store.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { useFeature } from "../hooks/useFeature.js";
import { UpgradeNotice } from "../components/UpgradeNotice.js";
import { ResizeHandle } from "../components/ResizeHandle.js";
import { Sheet } from "../components/Sheet.js";
import { cx } from "../util/classnames.js";
import { PANEL_DAG_CANVAS, usePanelLayout } from "../util/panelLayout.js";
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
const NODE_H = 64;
const PARENT_NODE_ID = "__parent__";

interface DagNodeData {
  node: DAGNode;
}

interface ParentNodeData {
  sessionSlug: string;
  parentDagId: string | null;
}

function layoutDag(dag: DAG): { nodes: Node[]; edges: Edge[]; rootIds: string[] } {
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
      data: { node: n } satisfies DagNodeData,
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

function DagNodeComponent({ data }: NodeProps<DagNodeData>) {
  const { node } = data;
  const activeId = useConnectionStore((s) => s.activeId);
  const hasAttention = useSessionStore((s) => {
    if (!node.sessionSlug || !activeId) return false;
    const sessions = s.byConnection.get(activeId)?.sessions ?? EMPTY_SESSIONS;
    const session = sessions.get(node.sessionSlug);
    return !!session && session.attention.length > 0;
  });
  const showAttention = hasAttention || node.status === "failed";

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
      style={{ width: NODE_W, minHeight: NODE_H }}
    >
      <Handle type="target" position={Position.Top} className="!bg-zinc-600" />
      {showAttention && (
        <span
          aria-label="needs attention"
          title={
            node.status === "failed"
              ? "node failed"
              : "session has attention flags"
          }
          className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold leading-none border border-red-300 shadow"
        >
          !
        </span>
      )}
      <div className="font-medium leading-tight truncate">{node.title}</div>
      <div className="mt-1 text-[10px] opacity-70">{node.status}</div>
      {node.sessionSlug && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (node.sessionSlug) goToSession(node.sessionSlug);
          }}
          className="mt-1 text-[10px] underline opacity-60 hover:opacity-100"
        >
          {node.sessionSlug}
        </button>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600" />
    </div>
  );
}

function ParentNodeComponent({ data }: NodeProps<ParentNodeData>) {
  const target = data.parentDagId ? "open parent DAG" : "open parent session";
  return (
    <div
      className="rounded-lg border border-dashed border-fg-subtle bg-bg-elev px-3 py-2 text-xs text-fg-muted cursor-pointer select-none"
      style={{ width: NODE_W, minHeight: NODE_H }}
      title={`double-click to ${target}`}
    >
      <div className="text-[10px] uppercase tracking-wide opacity-60">parent</div>
      <div className="font-medium leading-tight truncate">{data.sessionSlug}</div>
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
}

function DagCanvasInner({ dag, connectionId, onSelectDag }: CanvasProps) {
  const dagsMap = useDagStore(
    (s) => (connectionId ? s.byConnection.get(connectionId) ?? EMPTY_DAGS : EMPTY_DAGS),
  );

  const { nodes, edges } = useMemo(() => {
    const { nodes: baseNodes, edges: baseEdges, rootIds } = layoutDag(dag);

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
  }, [dag, dagsMap]);

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
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        setViewport(connectionId, dag.id, {
          x: viewport.x,
          y: viewport.y,
          scale: viewport.zoom,
        });
      }, 200);
    },
    [connectionId, dag.id],
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

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView={!defaultViewport}
        defaultViewport={defaultViewport}
        onMove={handleMove}
        onNodeDoubleClick={handleNodeDoubleClick}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#27272a" gap={20} />
        <Controls className="!bg-bg-elev !border-border" />
        <MiniMap className="!bg-bg-elev !border-border" nodeColor="#3f3f46" />
      </ReactFlow>
    </div>
  );
}

interface Props {
  sessionSlug?: string | null;
  dagId?: string;
}

function DagCanvasChrome({ children }: { children: ReactNode }) {
  const { size, collapsed, breakpoint, setSize, toggleCollapsed, setCollapsed } = usePanelLayout(
    PANEL_DAG_CANVAS,
    {
      defaultSize: DAG_DEFAULT_WIDTH,
      minSize: DAG_MIN_WIDTH,
      maxSize: DAG_MAX_WIDTH,
    },
  );
  const isMobile = breakpoint === "mobile";
  const showInline = !collapsed && !isMobile;
  const showSheet = !collapsed && isMobile;

  return (
    <div data-testid="panel-dag-canvas" className="flex flex-col h-full">
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
      {showInline && (
        <div className="flex flex-1 min-h-0">
          <div
            data-testid="panel-dag-canvas-body"
            className="flex flex-col min-w-0 overflow-hidden"
            style={{ width: size }}
          >
            {children}
          </div>
          <ResizeHandle
            direction="horizontal"
            onDrag={(delta) => setSize((s) => s + delta)}
          />
        </div>
      )}
      {showSheet && (
        <Sheet
          open
          onClose={() => setCollapsed(true)}
          title="DAG canvas"
          side="bottom"
        >
          <div data-testid="panel-dag-canvas-body" className="h-[70dvh]">
            {children}
          </div>
        </Sheet>
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
      <DagCanvasChrome>
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
    <DagCanvasChrome>
      <div className="flex flex-col h-full">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 border-b border-border bg-bg-soft text-sm">
          <button
            type="button"
            onClick={clearDag}
            className="text-fg-subtle hover:text-fg-muted"
          >
            ← all DAGs
          </button>
          <span className="text-fg font-medium truncate max-w-full">{selected.title}</span>
          <span className="pill bg-bg-elev text-fg-muted text-[10px]">{selected.status}</span>
          <span className="text-fg-subtle text-xs">{selected.nodes.length} nodes</span>
        </div>
        <div className="flex-1">
          <DagCanvasInner
            dag={selected}
            connectionId={activeId}
            onSelectDag={selectDag}
          />
        </div>
      </div>
    </DagCanvasChrome>
  );
}
