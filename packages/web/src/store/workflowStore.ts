import { create } from "zustand";
import type { Workflow, TaskNode, WorkflowEvent } from "@minions/engine-next";
import { applyEventToSnapshot } from "../transport/snapshotCache.js";

interface WorkflowStore {
  byConnection: Map<string, Map<string, Workflow>>;
  replaceAll: (connId: string, workflows: Workflow[]) => void;
  upsert: (connId: string, workflow: Workflow) => void;
  remove: (connId: string, workflowId: string) => void;
  applyEvent: (connId: string, event: WorkflowEvent) => void;
  /**
   * Apply an optimistic mutation to a workflow. Returns a rollback closure that
   * restores the prior state when invoked. No-op if the workflow is missing.
   */
  applyOptimisticWorkflow: (
    connId: string,
    workflowId: string,
    mutator: (prev: Workflow) => Workflow,
  ) => () => void;
}

export const EMPTY_WORKFLOWS: Map<string, Workflow> = new Map();

function withSlice(
  byConnection: Map<string, Map<string, Workflow>>,
  connId: string,
  mutator: (slice: Map<string, Workflow>) => void,
): Map<string, Map<string, Workflow>> {
  const next = new Map(byConnection);
  const existing = next.get(connId);
  const slice = existing ? new Map(existing) : new Map<string, Workflow>();
  mutator(slice);
  next.set(connId, slice);
  return next;
}

export const useWorkflowStore = create<WorkflowStore>((set) => ({
  byConnection: new Map(),

  replaceAll(connId, workflows) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.clear();
        for (const w of workflows) slice.set(w.id, w);
      }),
    }));
  },

  upsert(connId, workflow) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.set(workflow.id, workflow);
      }),
    }));
  },

  remove(connId, workflowId) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.delete(workflowId);
      }),
    }));
  },

  applyEvent(connId, event) {
    set(s => {
      const workflows = [...(s.byConnection.get(connId)?.values() ?? [])];
      const updated = applyEventToSnapshot({ workflows }, event);
      if (updated.workflows === workflows) return s;
      return {
        byConnection: withSlice(s.byConnection, connId, (slice) => {
          slice.clear();
          for (const w of updated.workflows) slice.set(w.id, w);
        }),
      };
    });
  },

  applyOptimisticWorkflow(connId, workflowId, mutator) {
    const prev = useWorkflowStore.getState().byConnection.get(connId)?.get(workflowId);
    if (!prev) return () => {};
    const next = mutator(prev);
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.set(workflowId, next);
      }),
    }));
    return () => {
      set(s => ({
        byConnection: withSlice(s.byConnection, connId, (slice) => {
          slice.set(workflowId, prev);
        }),
      }));
    };
  },
}));

/** Selector: all workflows for a connection as a sorted array (newest first). */
export function selectWorkflows(connId: string): Workflow[] {
  const slice = useWorkflowStore.getState().byConnection.get(connId);
  if (!slice) return [];
  return [...slice.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/** Selector: ordered task nodes for a workflow. */
export function selectTaskNodes(connId: string, workflowId: string): TaskNode[] {
  const workflow = useWorkflowStore.getState().byConnection.get(connId)?.get(workflowId);
  if (!workflow) return [];
  return Object.values(workflow.graph);
}

/** Selector: a single task node. */
export function selectTaskNode(
  connId: string,
  workflowId: string,
  taskId: string,
): TaskNode | undefined {
  return useWorkflowStore.getState().byConnection.get(connId)?.get(workflowId)?.graph[taskId];
}
