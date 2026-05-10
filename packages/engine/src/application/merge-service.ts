import { DomainError } from "../domain/errors.js";
import type { WorkflowEvent, MergePhase } from "../domain/events.js";
import type { Artifact } from "../domain/types.js";
import type { PullRequestRef, SCMPlugin } from "../plugins/scm-plugin.js";
import type { WorkspaceBackend } from "../plugins/workspace-backend.js";
import { slugify } from "../plugins/workspace-backend.js";
import type { Command, CommandResult } from "./commands.js";
import type { WorkflowRepository } from "./repository.js";
import type { Logger } from "../observability/logger.js";

export class MergeServiceError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, details: Record<string, unknown>) {
    super(code);
    this.name = "MergeServiceError";
    this.code = code;
    this.details = details;
  }
}

export class MergeConflictError extends Error {
  readonly conflictCode: string;
  readonly conflictPaths: string[] | undefined;

  constructor(conflictCode: string, message: string, conflictPaths?: string[]) {
    super(message);
    this.name = "MergeConflictError";
    this.conflictCode = conflictCode;
    this.conflictPaths = conflictPaths;
  }
}

export class MergeAbortedError extends Error {
  constructor() {
    super("merge aborted by signal");
    this.name = "MergeAbortedError";
  }
}

export interface MergeServiceDeps {
  repo: WorkflowRepository;
  applyCommand: (cmd: Command) => Promise<CommandResult>;
  scm: SCMPlugin;
  workspace: WorkspaceBackend;
  repoCoords: { owner: string; repo: string };
  baseBranch: string;
  now: () => string;
  log: Logger;
}

export interface MergeInput {
  workflowId: string;
  taskId: string;
  signal?: AbortSignal;
}

function deriveBranch(workflowId: string, taskId: string): string {
  return `minions/${slugify(workflowId)}_${slugify(taskId)}`;
}

async function getPRWithMergeable(
  scm: SCMPlugin,
  owner: string,
  repo: string,
  number: number,
): Promise<Awaited<ReturnType<SCMPlugin["getPullRequest"]>>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pr = await scm.getPullRequest({ owner, repo, number });
    if (pr.merged === true) return pr;
    if (pr.mergeable !== null) return pr;
    await new Promise<void>((r) => setTimeout(r, 1000));
  }
  throw new MergeConflictError("mergeable_unknown", "GitHub did not compute mergeability after 5 attempts");
}

type RunUntilOpenResult = {
  openReviewResult: CommandResult | undefined;
  prRef: PullRequestRef;
  branch: string;
};

export class MergeService {
  private readonly deps: MergeServiceDeps;

  constructor(deps: MergeServiceDeps) {
    this.deps = deps;
  }

  private emitPhase(workflowId: string, taskId: string, phase: MergePhase, status: "started" | "completed", error?: string): void {
    const event: WorkflowEvent = {
      cursor: 0,
      workflowId,
      occurredAt: this.deps.now(),
      kind: "merge-phase",
      payload: { taskId, phase, status, ...(error !== undefined ? { error } : {}) },
    };
    this.deps.repo.publishTransient(workflowId, event);
  }

  private buildConflictArtifact(phase: MergePhase, reason: string, conflictPaths?: string[]): Artifact {
    return {
      kind: "patch",
      ref: JSON.stringify({ phase, reason, ...(conflictPaths !== undefined ? { conflictPaths } : {}) }),
      producedBy: "merge-service",
      createdAt: this.deps.now(),
    };
  }

  private async handlePhaseError(err: unknown, opts: MergeInput): Promise<CommandResult> {
    const { repo, applyCommand, now } = this.deps;
    const { workflowId, taskId } = opts;

    if (err instanceof MergeAbortedError) {
      throw err;
    }

    if (err instanceof MergeServiceError) {
      this.emitPhase(workflowId, taskId, "finalize", "completed", "MERGE_INCONSISTENT");
      throw err;
    }

    if (err instanceof MergeConflictError) {
      const phase: MergePhase = err.conflictCode === "rebase_conflict" ? "rebase" : "applyMerge";
      const artifact = this.buildConflictArtifact(phase, err.message, err.conflictPaths);
      const currentWf = await repo.get(workflowId).catch(() => undefined);
      const currentTask = currentWf?.graph[taskId];
      const fromStatus = currentTask?.executionStatus;
      if (fromStatus === "finalizing" || fromStatus === "pr-open") {
        return applyCommand({
          kind: "transition-task",
          workflowId,
          transition: {
            kind: "merge-conflict",
            taskId,
            artifacts: [artifact],
            reason: err.message,
            now: now(),
          },
        });
      }
    }

    throw err;
  }

  private async finalizeMerge(opts: MergeInput, _prRef: PullRequestRef, mergedSha: string): Promise<CommandResult> {
    const { applyCommand, now } = this.deps;
    const { workflowId, taskId } = opts;

    this.emitPhase(workflowId, taskId, "finalize", "started");
    const maxAttempts = 3;
    let finalResult: CommandResult | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        finalResult = await applyCommand({
          kind: "transition-task",
          workflowId,
          transition: { kind: "merge-task", taskId, now: now() },
        });
        break;
      } catch (err) {
        if (attempt + 1 >= maxAttempts) {
          this.deps.log.error(
            `MERGE INCONSISTENCY: github merged sha=${mergedSha} but internal merge-task transition failed after ${maxAttempts} attempts. Operator must reconcile.`,
            { kind: "merge-inconsistent", workflowId, taskId, sha: mergedSha, error: (err as Error).message },
          );
          throw new MergeServiceError("merge_state_inconsistent", {
            sha: mergedSha,
            workflowId,
            taskId,
            cause: err,
          });
        }
        await new Promise<void>((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }
    this.emitPhase(workflowId, taskId, "finalize", "completed");
    return finalResult!;
  }

  private async finalizeAlreadyMerged(opts: MergeInput, prRef: PullRequestRef, mergedSha: string): Promise<CommandResult> {
    const { workflowId, taskId } = opts;
    this.emitPhase(workflowId, taskId, "applyMerge", "completed");
    return this.finalizeMerge(opts, prRef, mergedSha);
  }

  private async runUntilOpen(
    opts: MergeInput,
    setHandle: (h: Awaited<ReturnType<WorkspaceBackend["create"]>>) => void,
  ): Promise<RunUntilOpenResult> {
    const { repo, applyCommand, scm, workspace, repoCoords, baseBranch, now } = this.deps;
    const { workflowId, taskId, signal } = opts;

    this.emitPhase(workflowId, taskId, "prepareMerge", "started");
    const workflow = await repo.get(workflowId);
    if (!workflow) {
      throw new DomainError("not_found", "workflow not found", { workflowId });
    }
    const task = workflow.graph[taskId];
    if (!task) {
      throw new DomainError("not_found", "task not found", { taskId });
    }
    if (task.executionStatus !== "finalizing" && task.executionStatus !== "pr-open") {
      throw new DomainError(
        "invalid_transition",
        `merge requires task in finalizing or pr-open, got ${task.executionStatus}`,
        { taskId, executionStatus: task.executionStatus },
      );
    }
    const branch = deriveBranch(workflowId, taskId);
    const workspaceId = `ws-${slugify(workflowId)}_${slugify(taskId)}`;
    let workspaceHandle = await workspace.get(workspaceId);
    if (!workspaceHandle) {
      workspaceHandle = await workspace.create({ workflowId, taskId, branch, mode: "worktree", resetBranch: false });
    }
    setHandle(workspaceHandle);
    this.emitPhase(workflowId, taskId, "prepareMerge", "completed");

    if (signal?.aborted) throw new MergeAbortedError();

    this.emitPhase(workflowId, taskId, "commit", "started");
    await scm.pushBranch(workspaceHandle.path, branch);
    this.emitPhase(workflowId, taskId, "commit", "completed");

    if (signal?.aborted) throw new MergeAbortedError();

    this.emitPhase(workflowId, taskId, "squash", "started");
    this.emitPhase(workflowId, taskId, "squash", "completed");

    this.emitPhase(workflowId, taskId, "rebase", "started");
    const rebaseResult = await scm.rebase(workspaceHandle.path, baseBranch);
    if (rebaseResult.kind === "conflict") {
      throw new MergeConflictError(
        "rebase_conflict",
        `rebase conflict in ${rebaseResult.conflictPaths.join(", ")}`,
        rebaseResult.conflictPaths,
      );
    }
    await scm.pushBranch(workspaceHandle.path, branch);
    this.emitPhase(workflowId, taskId, "rebase", "completed");

    if (signal?.aborted) throw new MergeAbortedError();

    const existingPrRef = await scm.findPullRequest({ owner: repoCoords.owner, repo: repoCoords.repo, head: branch, base: baseBranch });
    let openReviewResult: CommandResult | undefined;
    let prRef: PullRequestRef;

    if (existingPrRef === null) {
      const wf = await repo.get(workflowId);
      const t = wf?.graph[taskId];
      const prTitle = t?.title ?? `Task ${taskId}`;
      prRef = await scm.openPullRequest({
        owner: repoCoords.owner,
        repo: repoCoords.repo,
        title: prTitle,
        body: `Created by minions task ${taskId} (workflow ${workflowId}).`,
        head: branch,
        base: baseBranch,
      });
      openReviewResult = await applyCommand({
        kind: "transition-task",
        workflowId,
        transition: {
          kind: "open-review",
          taskId,
          artifacts: [{ kind: "pr", ref: prRef.url, producedBy: "merge-service", createdAt: now() }],
          now: now(),
        },
      });
    } else {
      prRef = existingPrRef;
      try {
        openReviewResult = await applyCommand({
          kind: "transition-task",
          workflowId,
          transition: {
            kind: "open-review",
            taskId,
            artifacts: [{ kind: "pr", ref: prRef.url, producedBy: "merge-service", createdAt: now() }],
            now: now(),
          },
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === "invalid_transition") {
          openReviewResult = undefined;
        } else {
          throw err;
        }
      }
    }

    return { openReviewResult, prRef, branch };
  }

  private async buildIdempotentResult(opts: MergeInput): Promise<CommandResult> {
    const wf = await this.deps.repo.get(opts.workflowId);
    if (!wf) throw new DomainError("not_found", "workflow not found", { workflowId: opts.workflowId });
    return { workflow: wf, events: [] };
  }

  async openOnly(opts: MergeInput): Promise<CommandResult> {
    let workspaceHandle: Awaited<ReturnType<WorkspaceBackend["create"]>> | undefined;
    try {
      const open = await this.runUntilOpen(opts, (h) => { workspaceHandle = h; });
      return open.openReviewResult ?? await this.buildIdempotentResult(opts);
    } catch (err) {
      if (err instanceof MergeAbortedError) throw err;
      return this.handlePhaseError(err, opts);
    } finally {
      if (workspaceHandle !== undefined) {
        await this.deps.workspace.cleanup(workspaceHandle.workspaceId).catch((err) => {
          this.deps.log.error("workspace cleanup failed", { workspaceId: workspaceHandle!.workspaceId, error: (err as Error).message });
        });
      }
    }
  }

  async merge(opts: MergeInput): Promise<CommandResult> {
    let workspaceHandle: Awaited<ReturnType<WorkspaceBackend["create"]>> | undefined;
    try {
      const open = await this.runUntilOpen(opts, (h) => { workspaceHandle = h; });

      if (opts.signal?.aborted) throw new MergeAbortedError();

      const prDetail = await getPRWithMergeable(
        this.deps.scm,
        this.deps.repoCoords.owner,
        this.deps.repoCoords.repo,
        open.prRef.number,
      );

      if (prDetail.merged === true) {
        const mergedSha = prDetail.mergeCommitSha ?? prDetail.headSha;
        return await this.finalizeAlreadyMerged(opts, open.prRef, mergedSha);
      }

      if (prDetail.mergeableState !== null
          && prDetail.mergeableState !== "clean"
          && prDetail.mergeableState !== "unstable") {
        throw new MergeConflictError("not_mergeable", `PR not mergeable: mergeable_state=${prDetail.mergeableState}`);
      }

      if (opts.signal?.aborted) throw new MergeAbortedError();

      this.emitPhase(opts.workflowId, opts.taskId, "applyMerge", "started");
      const outcome = await this.deps.scm.mergePullRequest({
        owner: this.deps.repoCoords.owner,
        repo: this.deps.repoCoords.repo,
        number: open.prRef.number,
        expectedHeadSha: prDetail.headSha,
        method: "squash",
      });
      if (!outcome.merged) {
        throw new MergeConflictError(outcome.reason, `PR merge failed: reason=${outcome.reason}`);
      }
      this.emitPhase(opts.workflowId, opts.taskId, "applyMerge", "completed");

      return await this.finalizeMerge(opts, open.prRef, outcome.sha);
    } catch (err) {
      if (err instanceof MergeAbortedError) throw err;
      return this.handlePhaseError(err, opts);
    } finally {
      if (workspaceHandle !== undefined) {
        await this.deps.workspace.cleanup(workspaceHandle.workspaceId).catch((err) => {
          this.deps.log.error("workspace cleanup failed", { workspaceId: workspaceHandle!.workspaceId, error: (err as Error).message });
        });
      }
    }
  }
}
