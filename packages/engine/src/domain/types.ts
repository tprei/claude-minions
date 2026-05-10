import type { NodeRun } from "./runs.js";

// Top-level shape of a unit of work in the system. A workflow is one or more
// task nodes wired into a DAG, with a policy and a status that rolls up from
// the leaves.
export const WORKFLOW_KINDS = [
  "single-task",
  "think-thread",
  "ship",
  "variant-race",
  "loop",
  "manual-dag",
  "ci-heal",
  "merge-review",
] as const;

export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export type WorkflowStatus = "active" | "completed" | "failed" | "cancelled";

export type TaskExecutionStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "finalizing"
  | "quality-pending"
  | "ci-pending"
  | "pr-open"
  | "merged"
  | "failed"
  | "cancelled"
  | "needs-review";

export type TaskStackStatus =
  | "clean"
  | "restack-pending"
  | "restacking"
  | "restack-conflict"
  | "stale-artifacts";

export type ClaimMode = "read" | "write";

// A claim is a working-tree lock declared up front. The dispatcher uses
// claim conflicts to prevent two write-mode tasks from running concurrently
// against overlapping paths.
export interface Claim {
  // repo-relative POSIX path, no leading "./" and no trailing "/"
  scope: string;
  mode: ClaimMode;
}

// What a task promises to produce. Used by reviewers and gates to know what
// "done" looks like before runtime starts.
export interface Contract {
  summary: string;
  expectedArtifacts: string[];
}

export type ArtifactKind = "branch" | "commit" | "patch" | "pr" | "quality-report" | "ci-report";

// A piece of evidence the task produced (a branch, a PR url, a CI report).
// Artifacts accumulate on the task and are passed to downstream tasks via
// dependency fan-in.
export interface Artifact {
  kind: ArtifactKind;
  ref: string;
  producedBy: string;
  createdAt: string;
}

export type Readiness = "unknown" | "ready" | "blocked";

// One node in the workflow graph: a unit of work with a lifecycle, claims,
// a contract, and accumulated artifacts. Execution status and stack status
// are independent dimensions — a task can be `completed` but `restack-pending`.
export interface TaskNode {
  id: string;
  workflowId: string;
  title: string;
  prompt: string;
  parentId?: string;
  dependsOn: string[];
  executionStatus: TaskExecutionStatus;
  stackStatus: TaskStackStatus;
  priority: number;
  claims: Claim[];
  contract: Contract;
  artifacts: Artifact[];
  sessionId?: string;
  workspaceId?: string;
  mergeTarget?: string;
  runs: NodeRun[];
  readiness: Readiness;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type GraphOperationKind = "restack";

export type GraphOperationStatus = "pending" | "running" | "completed" | "conflict" | "failed";

// A long-running mutation against the graph itself (not a single task).
// Currently only `restack`. Idempotency-keyed and recoverable across crashes.
export interface GraphOperation {
  id: string;
  workflowId: string;
  kind: GraphOperationKind;
  targetNodeId: string;
  affectedNodeIds: string[];
  fromBase?: string;
  toBase?: string;
  status: GraphOperationStatus;
  attempt: number;
  idempotencyKey: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// Per-workflow scheduling constraints.
export interface WorkflowPolicy {
  maxConcurrent: number;
  autoLand: boolean;
  autoMergeOnGreen: boolean;
}

// Aggregate root. Owns its task graph and its in-flight graph operations.
// Version bumps on every write so concurrent actors detect conflicts.
export interface Workflow {
  id: string;
  kind: WorkflowKind;
  status: WorkflowStatus;
  directorSessionId?: string;
  graph: Record<string, TaskNode>;
  operations: Record<string, GraphOperation>;
  policy: WorkflowPolicy;
  createdFrom?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const TASK_SUCCESS_EXECUTION_STATUSES: ReadonlySet<TaskExecutionStatus> = new Set([
  "completed",
  "pr-open",
  "merged",
]);

// Tasks in these statuses still hold their declared claims, so the dispatcher
// must check claim conflicts against them even if no agent is running.
export const TASK_CLAIM_HOLDING_STATUSES: ReadonlySet<TaskExecutionStatus> = new Set([
  "ready",
  "running",
  "finalizing",
  "quality-pending",
  "ci-pending",
  "needs-review",
]);

// Tasks in these statuses occupy a runtime/agent slot and count toward
// `policy.maxConcurrent`. Gate-blocked tasks are excluded — no agent is busy.
export const TASK_AGENT_OCCUPYING_STATUSES: ReadonlySet<TaskExecutionStatus> = new Set([
  "ready",
  "running",
  "finalizing",
]);

export const TASK_TERMINAL_EXECUTION_STATUSES: ReadonlySet<TaskExecutionStatus> = new Set([
  "completed",
  "pr-open",
  "merged",
  "failed",
  "cancelled",
  "needs-review",
]);

export const TASK_WORKFLOW_COMPLETING_STATUSES: ReadonlySet<TaskExecutionStatus> = new Set([
  "completed",
  "pr-open",
  "merged",
  "failed",
  "cancelled",
]);

export interface TaskSpec {
  id: string;
  title: string;
  prompt: string;
  dependsOn?: string[];
  claims?: Claim[];
  contract?: Partial<Contract>;
  priority?: number;
  mergeTarget?: string;
}

export interface WorkflowSpec {
  id: string;
  kind: WorkflowKind;
  tasks: TaskSpec[];
  policy?: Partial<WorkflowPolicy>;
  directorSessionId?: string;
  createdFrom?: string;
}
