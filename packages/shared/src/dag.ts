export type DAGNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "ci-pending"
  | "ci-failed"
  | "landed"
  | "rebasing"
  | "rebase-conflict"
  | "cancelled";

export type DagNodeCiState = "passing" | "failing" | "pending";

export interface DagNodeCiCheck {
  name: string;
  bucket: "pass" | "fail" | "pending";
}

export interface DagNodeCiSummary {
  state: DagNodeCiState;
  counts: { passed: number; failed: number; pending: number };
  checks: DagNodeCiCheck[];
  prNumber?: number;
  prUrl?: string;
  updatedAt: string;
}

export interface DAGNode {
  id: string;
  title: string;
  prompt: string;
  status: DAGNodeStatus;
  dependsOn: string[];
  sessionSlug?: string;
  branch?: string;
  baseBranch?: string;
  pr?: { number: number; url: string };
  ciSummary?: DagNodeCiSummary | null;
  startedAt?: string;
  completedAt?: string;
  failedReason?: string | null;
  metadata: Record<string, unknown>;
}

export interface DAG {
  id: string;
  title: string;
  goal: string;
  repoId?: string;
  baseBranch?: string;
  rootSessionSlug?: string;
  nodes: DAGNode[];
  createdAt: string;
  updatedAt: string;
  status: "active" | "completed" | "failed" | "cancelled";
  metadata: Record<string, unknown>;
}

export interface DAGSplitRequest {
  dagId: string;
  nodeId: string;
  newNodes: { title: string; prompt: string; dependsOn: string[] }[];
}

export const RETRYABLE_DAG_NODE_STATUSES: ReadonlySet<DAGNodeStatus> = new Set([
  "failed",
  "ci-failed",
  "rebase-conflict",
  "cancelled",
]);

export function isRetryableDagNodeStatus(status: DAGNodeStatus): boolean {
  return RETRYABLE_DAG_NODE_STATUSES.has(status);
}
