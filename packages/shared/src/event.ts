export const TASK_EXECUTION_STATUSES = [
  "pending",
  "ready",
  "running",
  "completed",
  "finalizing",
  "quality-pending",
  "ci-pending",
  "pr-open",
  "merged",
  "failed",
  "cancelled",
  "needs-review",
] as const;

export type TaskExecutionStatus = (typeof TASK_EXECUTION_STATUSES)[number];

export const TASK_STACK_STATUSES = [
  "clean",
  "restack-pending",
  "restacking",
  "restack-conflict",
  "stale-artifacts",
] as const;

export type TaskStackStatus = (typeof TASK_STACK_STATUSES)[number];

export type WorkflowStatus = "active" | "completed" | "failed" | "cancelled";
export type GraphOperationKind = "restack";
export type GraphOperationStatus = "pending" | "running" | "completed" | "conflict" | "failed";

export type NodeRunTerminalReason =
  | "completed"
  | "failed"
  | "cancelled"
  | "recovered"
  | "timeout"
  | "interrupted";

export const TRANSITION_KINDS = [
  "mark-ready",
  "mark-running",
  "update-run",
  "complete-runtime",
  "start-finalization",
  "open-review",
  "start-quality-gate",
  "complete-quality-gate",
  "start-ci-gate",
  "complete-ci-gate",
  "merge-task",
  "complete-without-pr",
  "merge-conflict",
  "cancel-task",
  "recover-task",
  "mark-interrupted",
  "fail-task",
] as const;

export type TransitionKind = (typeof TRANSITION_KINDS)[number];

export const WORKFLOW_EVENT_KINDS = [
  "task-transitioned",
  "graph-operation-changed",
  "run-started",
  "run-ended",
  "workflow-status-changed",
  "provider-event",
  "merge-phase",
  "ci-poll-result",
] as const;

export type WorkflowEventKind = (typeof WORKFLOW_EVENT_KINDS)[number];

export type ProviderEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; output: unknown; isError?: boolean }
  | { kind: "permission_request"; id: string; tool: string; input: unknown }
  | { kind: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number; costUsd?: number }
  | { kind: "error"; recoverable: boolean; message: string; source?: string }
  | { kind: "final"; sessionRef: string; exitMetadata?: Record<string, unknown> };

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

export type CIPollOverallStatus = "pending" | "success" | "failure" | "neutral";

export interface CIPollCheck {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: string | null;
  url?: string;
}

export interface CIPollResultPayload {
  taskId: string;
  runId?: string;
  prNumber: number;
  headSha: string;
  overallStatus: CIPollOverallStatus;
  checks: CIPollCheck[];
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
    | { kind: "ci-poll-result"; payload: CIPollResultPayload }
  );
