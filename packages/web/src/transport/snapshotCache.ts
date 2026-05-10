import { get as idbGet, set as idbSet } from "idb-keyval";
import type { Workflow, WorkflowEvent } from "@minions/engine-next";

export interface ConnectionSnapshot {
  workflows: Workflow[];
}

export async function loadSnapshot(connId: string): Promise<ConnectionSnapshot | null> {
  const stored = await idbGet<ConnectionSnapshot>(`snap:${connId}`);
  return stored ?? null;
}

export async function saveSnapshot(connId: string, snapshot: ConnectionSnapshot): Promise<void> {
  await idbSet(`snap:${connId}`, snapshot);
}

export function applyEventToSnapshot(
  snapshot: ConnectionSnapshot,
  event: WorkflowEvent,
): ConnectionSnapshot {
  const idx = snapshot.workflows.findIndex((w) => w.id === event.workflowId);
  if (idx === -1) return snapshot;

  const workflow = snapshot.workflows[idx];
  if (!workflow) return snapshot;

  const updated = applyWorkflowEvent(workflow, event);
  if (updated === workflow) return snapshot;

  const workflows = [...snapshot.workflows];
  workflows[idx] = updated;
  return { workflows };
}

function applyWorkflowEvent(workflow: Workflow, event: WorkflowEvent): Workflow {
  switch (event.kind) {
    case "workflow-status-changed":
      return { ...workflow, status: event.payload.toStatus, updatedAt: event.occurredAt };

    case "task-transitioned": {
      const task = workflow.graph[event.payload.taskId];
      if (!task) return workflow;
      if (task.version > event.payload.taskVersion) return workflow;
      return {
        ...workflow,
        updatedAt: event.occurredAt,
        graph: {
          ...workflow.graph,
          [event.payload.taskId]: {
            ...task,
            executionStatus: event.payload.toExecutionStatus,
            stackStatus: event.payload.toStackStatus,
            version: event.payload.taskVersion,
            updatedAt: event.occurredAt,
          },
        },
      };
    }

    case "graph-operation-changed": {
      const op = workflow.operations[event.payload.operationId];
      if (!op) return workflow;
      return {
        ...workflow,
        updatedAt: event.occurredAt,
        operations: {
          ...workflow.operations,
          [event.payload.operationId]: {
            ...op,
            status: event.payload.toStatus,
            updatedAt: event.occurredAt,
          },
        },
      };
    }

    case "run-started":
    case "run-ended":
    case "provider-event":
    case "merge-phase":
      return workflow;

    default:
      return workflow;
  }
}
