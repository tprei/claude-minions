import type { TransitionKind } from "../application/transitions.js";
import type { RunEndedPayload, RunStartedPayload, TaskTransitionedPayload, WorkflowEvent } from "@minions/shared";
import type { Workflow } from "./types.js";

export type {
  CIPollCheck,
  CIPollOverallStatus,
  CIPollResultPayload,
  GraphOperationChangedPayload,
  MergePhase,
  MergePhasePayload,
  ProviderEventPayload,
  RunEndedPayload,
  RunStartedPayload,
  TaskTransitionedPayload,
  WorkflowEvent,
  WorkflowEventKind,
  WorkflowStatusChangedPayload,
} from "@minions/shared";

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
