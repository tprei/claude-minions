import type { Artifact } from "../domain/types.js";

export interface ConflictResolutionRequest {
  workflowId: string;
  taskId: string;
  workspacePath: string;
  branch: string;
  baseBranch: string;
  conflictPaths: string[];
  signal?: AbortSignal;
}

export type ConflictResolutionOutcome =
  | { kind: "resolved" }
  | { kind: "unresolved"; reason: string; artifact: Artifact };

// Resolves a rebase conflict left in a worktree (markers in tree, rebase
// in progress) so the merge can proceed. On success the branch is rebased
// clean and pushed; on failure the task is routed to needs-review.
export interface ConflictResolver {
  resolve(request: ConflictResolutionRequest): Promise<ConflictResolutionOutcome>;
}
