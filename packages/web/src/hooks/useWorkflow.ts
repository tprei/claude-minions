import type { Workflow, TaskNode, TaskExecutionStatus } from "@minions/engine-next";
import { useWorkflowStore } from "../store/workflowStore.js";
import { useConnectionStore } from "../connections/store.js";

export function useWorkflow(workflowId: string): Workflow | undefined {
  const activeId = useConnectionStore(s => s.activeId);
  return useWorkflowStore(s => activeId ? s.byConnection.get(activeId)?.get(workflowId) : undefined);
}

export function useTask(workflowId: string, taskId: string): TaskNode | undefined {
  const workflow = useWorkflow(workflowId);
  return workflow?.graph[taskId];
}

export function useTasksByStatus(workflowId: string, status: TaskExecutionStatus): TaskNode[] {
  const workflow = useWorkflow(workflowId);
  if (!workflow) return [];
  return Object.values(workflow.graph).filter(t => t.executionStatus === status);
}
