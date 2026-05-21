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
  retryDelayMs?: number;
  shouldFinalize?: (repoId: string) => boolean;
  workspace?: WorkspaceBackend;
  gitClient?: GitClient;
  repoRegistry?: RepoRegistry;
}

export class LocalFinalizeService {
  private static readonly DEFAULT_RETRY_DELAY_MS = 30_000;
  private readonly deps: LocalFinalizeServiceDeps;
  private readonly activeIterators = new Map<string, { iterator: AsyncIterator<WorkflowEvent> | null }>();
  private readonly activeTasks = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: LocalFinalizeServiceDeps) {
    this.deps = deps;
    deps.signal.addEventListener("abort", () => {
      for (const attachment of this.activeIterators.values()) {
        if (attachment.iterator !== null) void attachment.iterator.return?.();
      }
      this.activeIterators.clear();
      for (const timer of this.retryTimers.values()) clearTimeout(timer);
      this.retryTimers.clear();
    });
  }

  attach(workflowId: string): void {
    if (this.activeIterators.has(workflowId)) return;
    const attachment = { iterator: null };
    this.activeIterators.set(workflowId, attachment);
    void this.attachAsync(workflowId, attachment);
  }

  detach(workflowId: string): void {
    const attachment = this.activeIterators.get(workflowId);
    if (attachment?.iterator) void attachment.iterator.return?.();
    this.activeIterators.delete(workflowId);
    for (const key of this.retryTimers.keys()) {
      if (key.startsWith(`${workflowId}:`)) {
        this.clearRetryTimer(key);
      }
    }
  }

  private isAttached(workflowId: string, attachment: { iterator: AsyncIterator<WorkflowEvent> | null }): boolean {
    return !this.deps.signal.aborted && this.activeIterators.get(workflowId) === attachment;
  }

  private async attachAsync(workflowId: string, attachment: { iterator: AsyncIterator<WorkflowEvent> | null }): Promise<void> {
    const cursor = await this.deps.workflowRepo.latestCursor(workflowId);
    if (!this.isAttached(workflowId, attachment)) return;
    const workflow = await this.deps.workflowRepo.get(workflowId);
    if (!this.isAttached(workflowId, attachment)) return;
    if (!workflow) {
      if (this.activeIterators.get(workflowId) === attachment) this.activeIterators.delete(workflowId);
      return;
    }
    for (const [taskId, task] of Object.entries(workflow.graph)) {
      if (task.executionStatus === "finalizing") {
        this.enqueueFinalizeTask(workflowId, taskId);
      }
    }
    void this.consume(workflowId, cursor, attachment);
  }

  private async consume(workflowId: string, fromCursor: number, attachment: { iterator: AsyncIterator<WorkflowEvent> | null }): Promise<void> {
    const iterable = this.deps.workflowRepo.subscribe(workflowId, fromCursor);
    const iter = iterable[Symbol.asyncIterator]();
    if (!this.isAttached(workflowId, attachment)) {
      void iter.return?.();
      return;
    }
    attachment.iterator = iter;
    try {
      while (true) {
        if (!this.isAttached(workflowId, attachment)) break;
        const result = await iter.next();
        if (result.done) break;
        if (!this.isAttached(workflowId, attachment)) break;

        const event = result.value;
        if (event.kind !== "task-transitioned") continue;

        const { taskId, fromExecutionStatus: from, toExecutionStatus: to } = event.payload;
        const key = `${workflowId}:${taskId}`;
        if (to === "finalizing" && from !== "finalizing") {
          this.enqueueFinalizeTask(workflowId, taskId);
        } else if (from === "finalizing" && to !== "finalizing") {
          this.clearRetryTimer(key);
        }
      }
    } catch (err) {
      this.deps.log.error(`local-finalize-service: consume error for ${workflowId}`, {
        error: (err as Error).message,
      });
    } finally {
      if (this.activeIterators.get(workflowId) === attachment) this.activeIterators.delete(workflowId);
    }
  }

  private enqueueFinalizeTask(workflowId: string, taskId: string): void {
    if (this.deps.signal.aborted) return;
    const key = `${workflowId}:${taskId}`;
    if (this.activeTasks.has(key)) return;
    this.activeTasks.add(key);
    void this.finalizeTask(workflowId, taskId).finally(() => {
      this.activeTasks.delete(key);
    });
  }

  private async finalizeTask(workflowId: string, taskId: string): Promise<void> {
    if (this.deps.signal.aborted) return;
    const workflow = await this.deps.workflowRepo.get(workflowId);
    const task = workflow?.graph[taskId];
    if (!workflow || !task) return;
    if (task.executionStatus !== "finalizing") return;
    if (this.deps.shouldFinalize !== undefined && !this.deps.shouldFinalize(workflow.repoId)) return;
    const key = `${workflowId}:${taskId}`;

    try {
      const mergeResult = await this.tryMerge(workflowId, taskId);
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
      this.clearRetryTimer(key);
    } catch (err) {
      this.deps.log.error(`local-finalize-service: transition error for ${workflowId}:${taskId}`, {
        error: (err as Error).message,
      });
      this.scheduleRetry(key, workflowId, taskId);
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

  private scheduleRetry(key: string, workflowId: string, taskId: string): void {
    this.clearRetryTimer(key);
    if (this.deps.signal.aborted) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      if (this.deps.signal.aborted || !this.activeIterators.has(workflowId)) return;
      this.enqueueFinalizeTask(workflowId, taskId);
    }, this.deps.retryDelayMs ?? LocalFinalizeService.DEFAULT_RETRY_DELAY_MS);
    this.retryTimers.set(key, timer);
  }

  private clearRetryTimer(key: string): void {
    const timer = this.retryTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retryTimers.delete(key);
    }
  }
}
