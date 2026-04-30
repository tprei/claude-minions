import { create } from "zustand";
import type { DAG, DAGNode } from "../types.js";

interface DagStore {
  byConnection: Map<string, Map<string, DAG>>;
  replaceAll: (connId: string, dags: DAG[]) => void;
  upsert: (connId: string, dag: DAG) => void;
  remove: (connId: string, id: string) => void;
  upsertNode: (connId: string, dagId: string, node: DAGNode) => void;
  /**
   * Apply an optimistic mutation to a DAG. Returns a rollback closure that
   * restores the prior DAG when invoked. No-op if the DAG is missing.
   */
  applyOptimisticDag: (
    connId: string,
    id: string,
    mutator: (prev: DAG) => DAG,
  ) => () => void;
}

export const EMPTY_DAGS: Map<string, DAG> = new Map();

function withSlice(
  byConnection: Map<string, Map<string, DAG>>,
  connId: string,
  mutator: (slice: Map<string, DAG>) => void,
): Map<string, Map<string, DAG>> {
  const next = new Map(byConnection);
  const existing = next.get(connId);
  const slice = existing ? new Map(existing) : new Map<string, DAG>();
  mutator(slice);
  next.set(connId, slice);
  return next;
}

export const useDagStore = create<DagStore>((set) => ({
  byConnection: new Map(),

  replaceAll(connId, dags) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.clear();
        for (const d of dags) slice.set(d.id, d);
      }),
    }));
  },

  upsert(connId, dag) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.set(dag.id, dag);
      }),
    }));
  },

  remove(connId, id) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.delete(id);
      }),
    }));
  },

  upsertNode(connId, dagId, node) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        const dag = slice.get(dagId);
        if (!dag) return;
        const idx = dag.nodes.findIndex((n) => n.id === node.id);
        if (idx < 0) return;
        const nextNodes = dag.nodes.slice();
        nextNodes[idx] = node;
        slice.set(dagId, { ...dag, nodes: nextNodes });
      }),
    }));
  },

  applyOptimisticDag(connId, id, mutator) {
    const prev = useDagStore.getState().byConnection.get(connId)?.get(id);
    if (!prev) return () => {};
    const next = mutator(prev);
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.set(id, next);
      }),
    }));
    return () => {
      set(s => ({
        byConnection: withSlice(s.byConnection, connId, (slice) => {
          slice.set(id, prev);
        }),
      }));
    };
  },
}));
