// Events are produced with cursor: 0 as a placeholder. The repository
// overwrites cursor values at save time before persisting.
import type { TransitionKind } from "../application/transitions.js";
import type { NodeRunTerminalReason } from "./runs.js";
import type {
  GraphOperationKind,
  GraphOperationStatus,
  TaskExecutionStatus,
  TaskStackStatus,
  Workflow,
  WorkflowStatus,
} from "./types.js";
import type { ProviderEvent } from "../plugins/provider-plugin.js";

export type WorkflowEventKind =
  | "task-transitioned"
  | "graph-operation-changed"
  | "run-started"
  | "run-ended"
  | "workflow-status-changed"
  | "provider-event"
  | "merge-phase";

export interface TaskTransitionedPayload {
  taskId: string;
  transitionKind?: TransitionKind;
  fromExecutionStatus: TaskExecutionStatus;
  toExecutionStatus: TaskExecutionStatus;
  fromStackStatus: TaskStackStatus;
  toStackStatus: TaskStackStatus;
  taskVersion: number;
}

export interface GraphOperationChangedPayload {
  operationId: string;
  kind: GraphOperationKind;
  fromStatus: GraphOperationStatus | null;
  toStatus: GraphOperationStatus;
}

export interface RunStartedPayload {
  runId: string;
  taskId: string;
  attempt: number;
  runtimeSessionId: string;
  providerSessionRef?: string;
  providerType: string;
  runtimeType: string;
}

export interface RunEndedPayload {
  runId: string;
  taskId: string;
  attempt: number;
  terminalReason: NodeRunTerminalReason;
  providerSessionRef?: string;
}

export interface WorkflowStatusChangedPayload {
  fromStatus: WorkflowStatus;
  toStatus: WorkflowStatus;
}

export interface ProviderEventPayload {
  taskId: string;
  runId: string;
  providerEvent: ProviderEvent;
}

export type MergePhase = "prepareMerge" | "commit" | "squash" | "rebase" | "applyMerge" | "finalize";

export interface MergePhasePayload {
  taskId: string;
  phase: MergePhase;
  status: "started" | "completed";
  error?: string;
}

interface EventBase {
  cursor: number;
  workflowId: string;
  occurredAt: string;
}

export type WorkflowEvent = EventBase &
  (
    | { kind: "task-transitioned"; payload: TaskTransitionedPayload }
    | { kind: "graph-operation-changed"; payload: GraphOperationChangedPayload }
    | { kind: "run-started"; payload: RunStartedPayload }
    | { kind: "run-ended"; payload: RunEndedPayload }
    | { kind: "workflow-status-changed"; payload: WorkflowStatusChangedPayload }
    | { kind: "provider-event"; payload: ProviderEventPayload }
    | { kind: "merge-phase"; payload: MergePhasePayload }
  );

export function deriveEvents(
  prev: Workflow,
  next: Workflow,
  occurredAt: string,
  transitionKind?: TransitionKind,
): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  const base = { cursor: 0, workflowId: next.id, occurredAt } as const;

  if (prev.status !== next.status) {
    events.push({
      ...base,
      kind: "workflow-status-changed",
      payload: { fromStatus: prev.status, toStatus: next.status },
    });
  }

  for (const [taskId, nextTask] of Object.entries(next.graph)) {
    const prevTask = prev.graph[taskId];
    if (!prevTask) continue;

    const execChanged = prevTask.executionStatus !== nextTask.executionStatus;
    const stackChanged = prevTask.stackStatus !== nextTask.stackStatus;

    if (execChanged || stackChanged) {
      const payload: TaskTransitionedPayload = {
        taskId,
        fromExecutionStatus: prevTask.executionStatus,
        toExecutionStatus: nextTask.executionStatus,
        fromStackStatus: prevTask.stackStatus,
        toStackStatus: nextTask.stackStatus,
        taskVersion: nextTask.version,
      };
      if (transitionKind !== undefined) payload.transitionKind = transitionKind;
      events.push({ ...base, kind: "task-transitioned", payload });
    }

    const prevRuns = prevTask.runs;
    const nextRuns = nextTask.runs;

    if (nextRuns.length > prevRuns.length) {
      const newRun = nextRuns[nextRuns.length - 1];
      if (newRun) {
        const startedPayload: RunStartedPayload = {
          runId: newRun.id,
          taskId: newRun.taskId,
          attempt: newRun.attempt,
          runtimeSessionId: newRun.runtimeSessionId,
          providerType: newRun.providerType,
          runtimeType: newRun.runtimeType,
        };
        if (newRun.providerSessionRef !== undefined) {
          startedPayload.providerSessionRef = newRun.providerSessionRef;
        }
        events.push({ ...base, kind: "run-started", payload: startedPayload });
      }
    } else if (nextRuns.length === prevRuns.length && nextRuns.length > 0) {
      const prevLast = prevRuns[prevRuns.length - 1];
      const nextLast = nextRuns[nextRuns.length - 1];
      if (
        prevLast &&
        nextLast &&
        prevLast.endedAt === undefined &&
        nextLast.endedAt !== undefined &&
        nextLast.terminalReason !== undefined
      ) {
        const endedPayload: RunEndedPayload = {
          runId: nextLast.id,
          taskId: nextLast.taskId,
          attempt: nextLast.attempt,
          terminalReason: nextLast.terminalReason,
        };
        if (nextLast.providerSessionRef !== undefined) {
          endedPayload.providerSessionRef = nextLast.providerSessionRef;
        }
        events.push({ ...base, kind: "run-ended", payload: endedPayload });
      }
    }
  }

  for (const [opId, nextOp] of Object.entries(next.operations)) {
    const prevOp = prev.operations[opId];
    const prevStatus = prevOp?.status;
    if (prevStatus !== nextOp.status) {
      events.push({
        ...base,
        kind: "graph-operation-changed",
        payload: {
          operationId: opId,
          kind: nextOp.kind,
          fromStatus: prevStatus ?? null,
          toStatus: nextOp.status,
        },
      });
    }
  }

  return events;
}
