import { useCallback, useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  MarkerType,
  type NodeTypes,
  type Edge,
  type Node,
  type NodeProps,
  Handle,
  Position,
} from "reactflow";
import dagre from "dagre";
import type { DAG, DAGNode, DAGNodeStatus } from "@minions/shared";
import { useDagStore } from "../store/dagStore.js";
import { useConnectionStore } from "../connections/store.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { useFeature } from "../hooks/useFeature.js";
import { UpgradeNotice } from "../components/UpgradeNotice.js";
import { cx } from "../util/classnames.js";
import "reactflow/dist/style.css";

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
};

const NODE_W = 180;
const NODE_H = 64;

function layoutDag(dag: DAG): { nodes: Node[]; edges: Edge[] } {
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
      data: { node: n },
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

  return { nodes, edges };
}

function DagNodeComponent({ data }: NodeProps<{ node: DAGNode }>) {
  const { node } = data;
  const activeId = useConnectionStore.getState().activeId;

  const goToSession = (slug: string) => {
    const { view, query } = parseUrl();
    if (!activeId) return;
    setUrlState({ connectionId: activeId, view, sessionSlug: slug, query });
  };

  return (
    <div
      className={cx(
        "rounded-lg border px-3 py-2 text-xs w-44 cursor-default select-none",
        STATUS_COLOR[node.status],
      )}
      style={{ width: NODE_W, minHeight: NODE_H }}
    >
      <Handle type="target" position={Position.Top} className="!bg-zinc-600" />
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

const NODE_TYPES: NodeTypes = { dagNode: DagNodeComponent };

interface CanvasProps {
  dag: DAG;
}

function DagCanvasInner({ dag }: CanvasProps) {
  const { nodes, edges } = useMemo(() => layoutDag(dag), [dag]);

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
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

export function DagCanvasView({ dagId }: Props) {
  const enabled = useFeature("dags");
  const dagsMap = useDagStore((s) => s.dags);
  const dags = useMemo(() => Array.from(dagsMap.values()), [dagsMap]);
  const activeId = useConnectionStore((s) => s.activeId);

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
      <div className="p-6">
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
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-bg-soft text-sm">
        <button
          type="button"
          onClick={clearDag}
          className="text-fg-subtle hover:text-fg-muted"
        >
          ← all DAGs
        </button>
        <span className="text-fg font-medium">{selected.title}</span>
        <span className="pill bg-bg-elev text-fg-muted text-[10px]">{selected.status}</span>
        <span className="text-fg-subtle text-xs">{selected.nodes.length} nodes</span>
      </div>
      <div className="flex-1">
        <DagCanvasInner dag={selected} />
      </div>
    </div>
  );
}
