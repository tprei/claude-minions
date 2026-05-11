import type { Artifact, GraphOperation } from "../domain/types.js";
import type { RestackPlan } from "./restack.js";
import { GitClient, GitError } from "../plugins/git/git-client.js";
import { GitWorktreeWorkspaceBackend } from "../plugins/workspace/git-worktree-backend.js";

export type RestackOutcome =
  | { kind: "completed"; artifactsByTaskId: Record<string, Artifact[]> }
  | { kind: "conflict"; error: string };

export interface RestackExecutor {
  execute(plan: RestackPlan, operation: GraphOperation): Promise<RestackOutcome>;
}

export class NoopRestackExecutor implements RestackExecutor {
  execute(_plan: RestackPlan, _operation: GraphOperation): Promise<RestackOutcome> {
    return Promise.resolve({ kind: "completed", artifactsByTaskId: {} });
  }
}

export interface GitWorktreeRestackExecutorConfig {
  gitClient: GitClient;
  workspace: GitWorktreeWorkspaceBackend;
  now?: () => string;
}

/**
 * Rebases every descendant branch onto its rebased parent.
 *
 * Driven by `operation.fromBase` / `operation.toBase`, which describe the
 * ancestor's old vs new head. Descendants are processed in plan order so
 * that transitive grandchildren can use the head a parent landed at after
 * its own rebase.
 */
export class GitWorktreeRestackExecutor implements RestackExecutor {
  private readonly gitClient: GitClient;
  private readonly workspace: GitWorktreeWorkspaceBackend;
  private readonly now: () => string;

  constructor(config: GitWorktreeRestackExecutorConfig) {
    this.gitClient = config.gitClient;
    this.workspace = config.workspace;
    this.now = config.now ?? (() => new Date().toISOString());
  }

  async execute(plan: RestackPlan, operation: GraphOperation): Promise<RestackOutcome> {
    if (operation.fromBase === undefined || operation.toBase === undefined) {
      return { kind: "completed", artifactsByTaskId: {} };
    }

    if (operation.fromBase === operation.toBase) {
      return { kind: "completed", artifactsByTaskId: {} };
    }

    const baseShas = new Map<string, { oldHead: string; newHead: string }>();
    baseShas.set(plan.ancestorId, { oldHead: operation.fromBase, newHead: operation.toBase });

    const artifactsByTaskId: Record<string, Artifact[]> = {};

    for (const task of plan.descendants) {
      const parentId = task.dependsOn.find((id) => baseShas.has(id));
      if (parentId === undefined) continue;

      const parentSha = baseShas.get(parentId);
      if (parentSha === undefined) continue;
      const { oldHead, newHead } = parentSha;

      if (task.workspaceId === undefined) continue;

      const handle = await this.workspace.get(task.workspaceId);
      if (handle === undefined) continue;

      const worktreePath = handle.path;
      const branch = handle.branch;

      const childOldHead = await this.gitClient.revParse(worktreePath, "HEAD");

      if (oldHead === newHead) {
        // Parent ref didn't actually move (e.g. parent's rebase was a no-op).
        // Record current head so any transitive children see no movement either.
        baseShas.set(task.id, { oldHead: childOldHead, newHead: childOldHead });
        continue;
      }

      await this.tryFetchOrigin(worktreePath);

      try {
        await this.gitClient.run(worktreePath, ["rebase", "--onto", newHead, oldHead, branch]);
      } catch (err) {
        const message = formatRebaseError(err);
        await this.tryAbortRebase(worktreePath);
        return { kind: "conflict", error: message };
      }

      const childNewHead = await this.gitClient.revParse(worktreePath, "HEAD");
      baseShas.set(task.id, { oldHead: childOldHead, newHead: childNewHead });

      await this.tryPushBranch(worktreePath, branch);

      artifactsByTaskId[task.id] = [
        {
          kind: "commit",
          ref: childNewHead,
          producedBy: "restack-executor",
          createdAt: this.now(),
        },
      ];
    }

    return { kind: "completed", artifactsByTaskId };
  }

  private async tryFetchOrigin(worktreePath: string): Promise<void> {
    if (!(await this.hasOriginRemote(worktreePath))) return;
    try {
      await this.gitClient.run(worktreePath, ["fetch", "origin"]);
    } catch {
      // Fetch failures are tolerated — a stale local ref will surface as a rebase conflict
      // if the parent's new head is genuinely missing.
    }
  }

  private async tryAbortRebase(worktreePath: string): Promise<void> {
    try {
      await this.gitClient.run(worktreePath, ["rebase", "--abort"]);
    } catch {
      // Abort can fail if no rebase is in progress (rare); nothing left to do.
    }
  }

  private async tryPushBranch(worktreePath: string, branch: string): Promise<void> {
    if (!(await this.hasOriginRemote(worktreePath))) return;
    try {
      await this.gitClient.run(worktreePath, ["push", "--force-with-lease", "origin", branch]);
    } catch {
      // Local refs are already updated by the rebase; failing the whole operation
      // on a transient push error would force a redo of the rebase. Re-push is the
      // safer recovery path.
    }
  }

  private async hasOriginRemote(worktreePath: string): Promise<boolean> {
    try {
      await this.gitClient.run(worktreePath, ["remote", "get-url", "origin"]);
      return true;
    } catch {
      return false;
    }
  }
}

function formatRebaseError(err: unknown): string {
  if (err instanceof GitError) {
    return err.stderr.trim() || err.stdout.trim() || err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
