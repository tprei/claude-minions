import { DomainError } from "../domain/errors.js";
import type { Artifact } from "../domain/types.js";
import type { WorkflowEvent } from "../domain/events.js";
import type { ProviderEvent, ProviderPlugin } from "../plugins/provider-plugin.js";
import type { RuntimeBackend } from "../plugins/runtime-backend.js";
import type { SCMPlugin } from "../plugins/scm-plugin.js";
import type { GitClient } from "../plugins/git/git-client.js";
import type { QualityPlugin } from "../plugins/quality-plugin.js";
import { runProviderToCompletion } from "../plugins/providers/run-provider-sync.js";
import type {
  ConflictResolver,
  ConflictResolutionOutcome,
  ConflictResolutionRequest,
} from "../plugins/conflict-resolver.js";
import type { Command, CommandResult } from "./commands.js";
import type { WorkflowRepository } from "./repository.js";
import type { Logger } from "../observability/logger.js";

export interface ConflictResolutionServiceDeps {
  repo: WorkflowRepository;
  applyCommand: (cmd: Command) => Promise<CommandResult>;
  providerFactory: () => ProviderPlugin;
  runtime: RuntimeBackend;
  scm: SCMPlugin;
  git: GitClient;
  quality?: QualityPlugin;
  now: () => string;
  log: Logger;
  qualityDefaultTimeoutMs?: number;
}

type VerifyResult = { ok: true } | { ok: false; reason: string };

export class ConflictResolutionService implements ConflictResolver {
  private readonly deps: ConflictResolutionServiceDeps;
  private attempt = 0;

  constructor(deps: ConflictResolutionServiceDeps) {
    this.deps = deps;
  }

  async resolve(request: ConflictResolutionRequest): Promise<ConflictResolutionOutcome> {
    const { repo, applyCommand, providerFactory, runtime, scm, now, log } = this.deps;
    const { workflowId, taskId, workspacePath, branch, baseBranch, conflictPaths, signal } = request;

    const workflow = await repo.get(workflowId);
    if (!workflow) {
      throw new DomainError("not_found", "workflow not found", { workflowId });
    }
    const runId = `resolve-${taskId}-${++this.attempt}`;

    await applyCommand({
      kind: "transition-task",
      workflowId,
      transition: { kind: "start-conflict-resolution", taskId, now: now() },
    });
    this.emitPhase(workflowId, taskId, "started");

    let sessionId: string | undefined;
    try {
      const provider = providerFactory();
      const prompt = buildResolutionPrompt(branch, baseBranch, conflictPaths);
      const invocation = await provider.prepare({
        taskId,
        workflowId,
        prompt,
        dependencyArtifacts: [],
        workflowKind: workflow.kind,
      });
      const startSpec: { taskId: string; workflowId: string; command: string[]; env?: Record<string, string>; workspacePath?: string } = {
        taskId,
        workflowId,
        command: invocation.command,
        workspacePath,
      };
      if (invocation.env !== undefined) startSpec.env = invocation.env;
      const started = await runtime.start(startSpec);
      sessionId = started.sessionId;

      const runOpts = signal !== undefined ? { signal } : {};
      const summary = await runProviderToCompletion(runtime, sessionId, provider, runOpts, (event) => {
        this.publishProviderEvent(workflowId, taskId, runId, event);
      });

      if (summary.fatalError !== undefined) {
        return await this.fail(request, `resolution agent errored: ${summary.fatalError.message}`);
      }
      if (!summary.finalReceived) {
        return await this.fail(request, "resolution agent ended without completing");
      }

      const verification = await this.verifyResolution(workspacePath, signal);
      if (!verification.ok) {
        return await this.fail(request, verification.reason);
      }

      await scm.pushBranch(workspacePath, branch);
      await applyCommand({
        kind: "transition-task",
        workflowId,
        transition: { kind: "complete-conflict-resolution", taskId, now: now() },
      });
      this.emitPhase(workflowId, taskId, "completed");
      return { kind: "resolved" };
    } catch (err) {
      log.error("conflict-resolution: unexpected error", { workflowId, taskId, error: (err as Error).message });
      return await this.fail(request, `resolution failed: ${(err as Error).message}`);
    } finally {
      if (sessionId !== undefined) {
        await runtime.stop(sessionId).catch(() => {});
      }
    }
  }

  private async verifyResolution(workspacePath: string, signal: AbortSignal | undefined): Promise<VerifyResult> {
    const { git, quality, qualityDefaultTimeoutMs, log } = this.deps;

    if (await git.isRebaseInProgress(workspacePath)) {
      const continued = await git.rebaseContinue(workspacePath);
      if (continued.kind === "conflict") {
        return { ok: false, reason: `rebase still conflicting in ${continued.conflictPaths.join(", ")}` };
      }
      if (await git.isRebaseInProgress(workspacePath)) {
        return { ok: false, reason: "rebase still in progress after continue" };
      }
    }

    if (await git.hasConflictMarkers(workspacePath)) {
      return { ok: false, reason: "conflict markers remain in worktree" };
    }
    if (!(await git.statusIsClean(workspacePath))) {
      return { ok: false, reason: "worktree not clean after rebase" };
    }

    if (quality === undefined) {
      log.info("conflict-resolution: no quality plugin; build not verified", {});
      return { ok: true };
    }
    const configs = await quality.loadConfig(workspacePath);
    if (configs.length === 0) {
      log.info("conflict-resolution: no quality config; build not verified", {});
      return { ok: true };
    }
    const runOpts: { signal?: AbortSignal; defaultTimeoutMs?: number } = {};
    if (signal !== undefined) runOpts.signal = signal;
    if (qualityDefaultTimeoutMs !== undefined) runOpts.defaultTimeoutMs = qualityDefaultTimeoutMs;
    const result = await quality.run(configs, workspacePath, runOpts);
    if (result.status !== "passed") {
      return { ok: false, reason: `build verification did not pass after conflict resolution (${result.status})` };
    }
    return { ok: true };
  }

  private async fail(request: ConflictResolutionRequest, reason: string): Promise<ConflictResolutionOutcome> {
    const { applyCommand, git, now } = this.deps;
    const { workflowId, taskId, workspacePath, conflictPaths } = request;

    await git.rebaseAbort(workspacePath);
    const artifact = this.buildConflictArtifact(reason, conflictPaths);
    await applyCommand({
      kind: "transition-task",
      workflowId,
      transition: { kind: "fail-conflict-resolution", taskId, artifacts: [artifact], reason, now: now() },
    });
    this.emitPhase(workflowId, taskId, "completed", reason);
    return { kind: "unresolved", reason, artifact };
  }

  private buildConflictArtifact(reason: string, conflictPaths: string[]): Artifact {
    return {
      kind: "conflict",
      ref: JSON.stringify({ phase: "resolveConflict", reason, conflictPaths, attempted: true }),
      producedBy: "conflict-resolution",
      createdAt: this.deps.now(),
    };
  }

  private emitPhase(workflowId: string, taskId: string, status: "started" | "completed", error?: string): void {
    const event: WorkflowEvent = {
      cursor: 0,
      workflowId,
      occurredAt: this.deps.now(),
      kind: "merge-phase",
      payload: { taskId, phase: "resolveConflict", status, ...(error !== undefined ? { error } : {}) },
    };
    this.deps.repo.publishTransient(workflowId, event);
  }

  private publishProviderEvent(workflowId: string, taskId: string, runId: string, providerEvent: ProviderEvent): void {
    const event: WorkflowEvent = {
      cursor: 0,
      workflowId,
      occurredAt: this.deps.now(),
      kind: "provider-event",
      payload: { taskId, runId, providerEvent },
    };
    this.deps.repo.publishTransient(workflowId, event);
  }
}

function buildResolutionPrompt(branch: string, baseBranch: string, conflictPaths: string[]): string {
  const files = conflictPaths.length > 0 ? conflictPaths.map((p) => `- ${p}`).join("\n") : "- (run `git status` to list them)";
  return `You are resolving a git rebase conflict inside a worktree. A rebase of branch \`${branch}\` onto \`${baseBranch}\` stopped on conflicts.

Conflicting files:
${files}

Do this:
1. Inspect each conflicting file and resolve every conflict marker (<<<<<<<, =======, >>>>>>>) by integrating BOTH sides' intent. Do not discard either side's changes unless one is a strict superset of the other.
2. Stage resolved files: \`git add -A\`.
3. Continue the rebase: \`git -c core.editor=true rebase --continue\`. If it stops again on more conflicts, repeat steps 1-3 until the rebase completes (no rebase in progress).
4. Verify the tree is clean (\`git status\`) and no conflict markers remain.
5. Do NOT push, do NOT open or merge a PR, and do NOT amend unrelated commits. Stop once the rebase is complete and the tree is clean.

If the conflict cannot be resolved without losing correctness, run \`git rebase --abort\` and stop — the system will route this to human review.`;
}
