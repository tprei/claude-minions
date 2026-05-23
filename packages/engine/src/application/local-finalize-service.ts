import type { WorkflowEvent } from "../domain/events.js";
import type { Command, CommandResult } from "./commands.js";
import type { WorkflowRepository } from "./repository.js";
import type { Logger } from "../observability/logger.js";
import type { WorkspaceBackend } from "../plugins/workspace-backend.js";
import type { GitClient } from "../plugins/git/git-client.js";
import { GitError } from "../plugins/git/git-client.js";
import type { RepoRegistry } from "./repo-registry.js";

export interface LocalFinalizeServiceDeps {
  workflowRepo: WorkflowRepository;
  applyCommand: (cmd: Command) => Promise<CommandResult>;
  signal: AbortSignal;
  now: () => string;
  log: Logger;
  workspace?: WorkspaceBackend;
  gitClient?: GitClient;
  repoRegistry?: RepoRegistry;
}

export class LocalFinalizeService {
  private readonly deps: LocalFinalizeServiceDeps;
  private readonly activeIterators = new Map<string, AsyncIterator<WorkflowEvent> | null>();
  private readonly taskControllers = new Map<string, AbortController>();

  constructor(deps: LocalFinalizeServiceDeps) {
    this.deps = deps;
    deps.signal.addEventListener("abort", () => {
      for (const iter of this.activeIterators.values()) {
        if (iter !== null) void iter.return?.();
      }
      this.activeIterators.clear();
      for (const ctrl of this.taskControllers.values()) ctrl.abort();
      this.taskControllers.clear();
    });
  }

  attach(workflowId: string): void {
    if (this.activeIterators.has(workflowId)) return;
    this.activeIterators.set(workflowId, null);
    void this.attachAsync(workflowId);
  }

  detach(workflowId: string): void {
    const iter = this.activeIterators.get(workflowId);
    if (iter) void iter.return?.();
    this.activeIterators.delete(workflowId);
    for (const key of this.taskControllers.keys()) {
      if (key.startsWith(`${workflowId}:`)) {
        this.taskControllers.get(key)?.abort();
        this.taskControllers.delete(key);
      }
    }
  }

  private spawnFinalizeForTask(workflowId: string, taskId: string): void {
    const key = `${workflowId}:${taskId}`;
    if (this.taskControllers.has(key)) return;
    const ctrl = new AbortController();
    this.taskControllers.set(key, ctrl);
    void this.finalizeTask(workflowId, taskId, ctrl.signal)
      .catch((err) => this.deps.log.error(`local-finalize-service: finalizeTask error for ${key}`, { error: (err as Error).message }))
      .finally(() => {
        if (this.taskControllers.get(key) === ctrl) this.taskControllers.delete(key);
      });
  }

  private async attachAsync(workflowId: string): Promise<void> {
    const cursor = await this.deps.workflowRepo.latestCursor(workflowId);
    const workflow = await this.deps.workflowRepo.get(workflowId);
    if (!workflow) {
      this.activeIterators.delete(workflowId);
      return;
    }
    for (const [taskId, task] of Object.entries(workflow.graph)) {
      if (task.executionStatus === "finalizing") {
        this.spawnFinalizeForTask(workflowId, taskId);
      }
    }
    void this.consume(workflowId, cursor);
  }

  private async consume(workflowId: string, fromCursor: number): Promise<void> {
    const iterable = this.deps.workflowRepo.subscribe(workflowId, fromCursor);
    const iter = iterable[Symbol.asyncIterator]();
    this.activeIterators.set(workflowId, iter);
    try {
      while (true) {
        if (this.deps.signal.aborted) break;
        const result = await iter.next();
        if (result.done) break;
        if (this.deps.signal.aborted) break;

        const event = result.value;
        if (event.kind !== "task-transitioned") continue;

        const { taskId, toExecutionStatus: to } = event.payload;
        if (to === "finalizing") {
          this.spawnFinalizeForTask(workflowId, taskId);
        }
      }
    } catch (err) {
      this.deps.log.error(`local-finalize-service: consume error for ${workflowId}`, {
        error: (err as Error).message,
      });
    } finally {
      this.activeIterators.delete(workflowId);
    }
  }

  private async finalizeTask(workflowId: string, taskId: string, taskSignal: AbortSignal): Promise<void> {
    if (this.deps.signal.aborted || taskSignal.aborted) return;

    const mergeResult = await this.tryMerge(workflowId, taskId);

    try {
      if (mergeResult.kind === "merged") {
        await this.deps.applyCommand({
          kind: "transition-task",
          workflowId,
          transition: {
            kind: "complete-without-pr",
            taskId,
            now: this.deps.now(),
          },
        });
      } else {
        await this.deps.applyCommand({
          kind: "transition-task",
          workflowId,
          transition: {
            kind: "merge-conflict",
            taskId,
            artifacts: [
              {
                kind: "patch",
                ref: mergeResult.reason,
                producedBy: taskId,
                createdAt: this.deps.now(),
              },
            ],
            now: this.deps.now(),
          },
        });
      }
    } catch (err) {
      this.deps.log.error(`local-finalize-service: transition error for ${workflowId}:${taskId}`, {
        error: (err as Error).message,
      });
    }
  }

  private async tryMerge(
    workflowId: string,
    taskId: string,
  ): Promise<{ kind: "merged" } | { kind: "needs-review"; reason: string }> {
    const { workspace, gitClient, repoRegistry } = this.deps;

    if (!workspace || !gitClient || !repoRegistry) {
      return { kind: "merged" };
    }

    const workflow = await this.deps.workflowRepo.get(workflowId);
    const task = workflow?.graph[taskId];
    if (!task?.workspaceId) {
      return { kind: "needs-review", reason: "task has no workspaceId — agent may not have run in a worktree" };
    }

    const handle = await workspace.get(task.workspaceId);
    if (!handle) {
      return { kind: "needs-review", reason: `workspace ${task.workspaceId} not found` };
    }

    const binding = repoRegistry.require(workflow!.repoId);
    const repoPath = binding.localPath;
    const branch = handle.branch;
    const baseBranch = task.mergeTarget ?? binding.defaultBranch;

    // Check whether the worktree branch has any commits ahead of the base branch.
    // mergeBase...branch gives commits reachable from branch but not from base.
    let aheadCount: string;
    try {
      const mergeBase = await gitClient.revParse(repoPath, `${baseBranch}...${branch}`);
      // rev-list --count gives the number of commits ahead
      const { stdout } = await gitClient.run(repoPath, ["rev-list", "--count", `${baseBranch}..${branch}`]);
      aheadCount = stdout.trim();
      void mergeBase; // used to surface errors on invalid refs
    } catch (err) {
      const msg = err instanceof GitError ? err.stderr : String(err);
      return { kind: "needs-review", reason: `could not compare branch to base: ${msg}` };
    }

    if (aheadCount === "0") {
      return {
        kind: "needs-review",
        reason: `branch ${branch} has no commits ahead of ${baseBranch} — agent did not commit`,
      };
    }

    // Resolve the current HEAD of the base branch so we can restore it on conflict.
    let baseHead: string;
    try {
      baseHead = await gitClient.revParse(repoPath, baseBranch);
    } catch (err) {
      const msg = err instanceof GitError ? err.stderr : String(err);
      return { kind: "needs-review", reason: `could not resolve ${baseBranch}: ${msg}` };
    }

    // Attempt fast-forward merge first, then fall back to a regular merge.
    try {
      await gitClient.run(repoPath, [
        "-c", `user.email=minions@local`,
        "-c", `user.name=minions`,
        "merge",
        "--ff-only",
        branch,
      ]);
      this.deps.log.info(`local-finalize-service: merged ${branch} → ${baseBranch} (ff-only)`, {
        workflowId,
        taskId,
        branch,
        baseBranch,
      });
      return { kind: "merged" };
    } catch {
      // ff-only failed — try a regular merge
    }

    try {
      await gitClient.run(repoPath, [
        "-c", `user.email=minions@local`,
        "-c", `user.name=minions`,
        "merge",
        "--no-ff",
        "-m", `Merge branch '${branch}' into ${baseBranch}`,
        branch,
      ]);
      this.deps.log.info(`local-finalize-service: merged ${branch} → ${baseBranch} (no-ff)`, {
        workflowId,
        taskId,
        branch,
        baseBranch,
      });
      return { kind: "merged" };
    } catch (err) {
      const msg = err instanceof GitError ? err.stderr : String(err);

      // Abort the merge to leave the repo in a clean state.
      try {
        await gitClient.run(repoPath, ["merge", "--abort"]);
      } catch {
        // best-effort abort; restore HEAD manually if needed
        try {
          await gitClient.run(repoPath, ["reset", "--hard", baseHead]);
        } catch {
          // nothing more we can do
        }
      }

      return { kind: "needs-review", reason: `merge conflict: ${msg}` };
    }
  }
}
