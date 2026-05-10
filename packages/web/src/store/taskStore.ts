import type { TaskNode } from "@minions/engine-next";
import { useWorkflowStore, selectTaskNode, selectTaskNodes } from "./workflowStore.js";

/**
 * Task-level projection helpers over workflowStore.
 *
 * Tasks are not stored independently — they live in Workflow.graph. These
 * helpers expose task-scoped reads and optimistic mutations without a
 * separate Zustand store slice.
 */

export { selectTaskNodes, selectTaskNode };

/**
 * Apply an optimistic mutation to a single task node. Returns a rollback
 * closure. No-op if the workflow or task is missing.
 */
export function applyOptimisticTask(
  connId: string,
  workflowId: string,
  taskId: string,
  mutator: (prev: TaskNode) => TaskNode,
): () => void {
  const workflow = useWorkflowStore.getState().byConnection.get(connId)?.get(workflowId);
  if (!workflow) return () => {};
  const prevTask = workflow.graph[taskId];
  if (!prevTask) return () => {};

  return useWorkflowStore.getState().applyOptimisticWorkflow(connId, workflowId, (w) => ({
    ...w,
    graph: {
      ...w.graph,
      [taskId]: mutator(prevTask),
    },
  }));
}

/**
 * Selector: tasks for a workflow filtered by execution status.
 */
export function selectTasksByStatus(
  connId: string,
  workflowId: string,
  statuses: ReadonlySet<string>,
): TaskNode[] {
  return selectTaskNodes(connId, workflowId).filter((t) =>
    statuses.has(t.executionStatus),
  );
}
