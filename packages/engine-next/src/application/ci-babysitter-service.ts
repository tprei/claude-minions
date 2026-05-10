import type { WorkflowEvent } from "../domain/events.js";
import type { Artifact } from "../domain/types.js";
import { GitHubApiError } from "../plugins/github/github-client.js";
import type { GitHubClient } from "../plugins/github/github-client.js";
import type { Command, CommandResult } from "./commands.js";
import type { WorkflowRepository } from "./repository.js";
import type { ContinueTaskService } from "./continue-task-service.js";
import { MergeAbortedError, MergeConflictError, MergeService, MergeServiceError } from "./merge-service.js";
import type { Logger } from "../observability/logger.js";

export interface PollCadenceInterval {
  afterMs: number;
  everyMs: number;
}

export interface PollCadence {
  intervals: PollCadenceInterval[];
  maxHorizonMs: number;
  noChecksBailMs: number;
  confirmationDelayMs: number;
}

const DEFAULT_CADENCE: PollCadence = {
  intervals: [
    { afterMs: 0, everyMs: 15_000 },
    { afterMs: 2 * 60_000, everyMs: 30_000 },
    { afterMs: 10 * 60_000, everyMs: 60_000 },
  ],
  maxHorizonMs: 2 * 60 * 60_000,
  noChecksBailMs: 2 * 60_000,
  confirmationDelayMs: 30_000,
};

const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "stale"]);

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

export interface CIBabysitterServiceDeps {
  workflowRepo: WorkflowRepository;
  github: GitHubClient;
  repoCoords: { owner: string; repo: string };
  applyCommand: (cmd: Command) => Promise<CommandResult>;
  continueTaskService: ContinueTaskService;
  mergeService?: MergeService;
  signal: AbortSignal;
  now: () => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  cadence?: PollCadence;
  log: Logger;
}

export class CIBabysitterService {
  private readonly deps: CIBabysitterServiceDeps;
  private readonly activeIterators = new Map<string, AsyncIterator<WorkflowEvent>>();
  private readonly taskControllers = new Map<string, AbortController>();
  private readonly cadence: PollCadence;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(deps: CIBabysitterServiceDeps) {
    this.deps = deps;
    this.cadence = deps.cadence ?? DEFAULT_CADENCE;
    this.sleep = deps.sleep ?? defaultSleep;

    deps.signal.addEventListener("abort", () => {
      for (const iter of this.activeIterators.values()) {
        if (iter !== null) {
          void iter.return?.();
        }
      }
      for (const ctrl of this.taskControllers.values()) {
        ctrl.abort();
      }
      this.taskControllers.clear();
    });
  }

  attach(workflowId: string): void {
    if (this.activeIterators.has(workflowId)) return;
    this.activeIterators.set(workflowId, null as unknown as AsyncIterator<WorkflowEvent>);
    void this.attachAsync(workflowId);
  }

  private async attachAsync(workflowId: string): Promise<void> {
    const workflow = await this.deps.workflowRepo.get(workflowId);
    if (!workflow) {
      this.activeIterators.delete(workflowId);
      return;
    }
    for (const [taskId, task] of Object.entries(workflow.graph)) {
      if (task.executionStatus === "pr-open") {
        const key = `${workflowId}:${taskId}`;
        if (!this.taskControllers.has(key)) {
          const ctrl = new AbortController();
          this.taskControllers.set(key, ctrl);
          void this.pollPR(workflowId, taskId, ctrl.signal).catch((err) => {
            this.deps.log.error(`ci-babysitter: pollPR error for ${key}`, { error: (err as Error).message });
          }).finally(() => {
            if (this.taskControllers.get(key) === ctrl) {
              this.taskControllers.delete(key);
            }
          });
        }
      }
    }
    void this.consume(workflowId);
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

  private async consume(workflowId: string): Promise<void> {
    const latestCursor = await this.deps.workflowRepo.latestCursor(workflowId);
    const iterable = this.deps.workflowRepo.subscribe(workflowId, latestCursor);
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

        const { taskId, fromExecutionStatus: from, toExecutionStatus: to } = event.payload;
        const key = `${workflowId}:${taskId}`;

        if (to === "pr-open" && from !== "pr-open") {
          const existing = this.taskControllers.get(key);
          if (existing) {
            existing.abort();
            this.taskControllers.delete(key);
          }
          const ctrl = new AbortController();
          this.taskControllers.set(key, ctrl);
          void this.pollPR(workflowId, taskId, ctrl.signal).catch((err) => {
            this.deps.log.error(`ci-babysitter: pollPR error for ${key}`, { error: (err as Error).message });
          }).finally(() => {
            if (this.taskControllers.get(key) === ctrl) {
              this.taskControllers.delete(key);
            }
          });
        } else if (from === "pr-open" && to !== "pr-open") {
          const ctrl = this.taskControllers.get(key);
          if (ctrl) {
            ctrl.abort();
            this.taskControllers.delete(key);
          }
        }
      }
    } catch (err) {
      this.deps.log.error(`ci-babysitter: consume error for ${workflowId}`, { error: (err as Error).message });
    } finally {
      this.activeIterators.delete(workflowId);
    }
  }

  private async pollPR(workflowId: string, taskId: string, signal: AbortSignal): Promise<void> {
    const { workflowRepo, github, repoCoords, applyCommand, continueTaskService, now } = this.deps;

    const workflow = await workflowRepo.get(workflowId);
    if (!workflow) return;

    const task = workflow.graph[taskId];
    if (!task || task.executionStatus !== "pr-open") return;

    const prArtifact = [...task.artifacts].reverse().find((a) => a.kind === "pr");
    if (!prArtifact) {
      this.deps.log.error(`ci-babysitter: no pr artifact on task ${taskId}`, { taskId, workflowId });
      return;
    }

    const prUrlMatch = prArtifact.ref.match(/\/pull\/(\d+)(?:$|\?|#)/);
    if (!prUrlMatch) {
      this.deps.log.error(`ci-babysitter: could not parse PR number from ref on task ${taskId}`, { taskId, workflowId, ref: prArtifact.ref });
      return;
    }
    const prNumber = parseInt(prUrlMatch[1]!, 10);

    const ciReportCount = task.artifacts.filter((a) => a.kind === "ci-report").length;
    if (ciReportCount >= 1) {
      this.deps.log.info(`ci-babysitter: ci attempt cap reached for task ${taskId}`, { kind: "ci-attempt-cap", taskId, workflowId });
      return;
    }

    let prDetail: { headSha: string; url: string };
    try {
      const pr = await github.getPR(repoCoords.owner, repoCoords.repo, prNumber);
      prDetail = { headSha: pr.headSha, url: pr.url };
    } catch (err) {
      this.deps.log.error(`ci-babysitter: getPR failed for task ${taskId}`, { taskId, workflowId, error: (err as Error).message });
      return;
    }

    const { headSha } = prDetail;
    const prUrl = prDetail.url;
    const startMs = Date.now();
    let lastSeenAllComplete = false;

    while (true) {
      if (signal.aborted) return;

      const elapsed = Date.now() - startMs;
      if (elapsed > this.cadence.maxHorizonMs) {
        this.deps.log.info(`ci-babysitter: max horizon reached for task ${taskId}`, { taskId, workflowId });
        return;
      }

      const interval = pickInterval(this.cadence.intervals, elapsed);

      try {
        await this.sleep(interval.everyMs, signal);
      } catch {
        return;
      }

      if (signal.aborted) return;

      const wfCurrent = await workflowRepo.get(workflowId);
      const taskCurrent = wfCurrent?.graph[taskId];
      if (!taskCurrent || taskCurrent.executionStatus !== "pr-open") return;

      let runs: Awaited<ReturnType<GitHubClient["listCheckRuns"]>>;
      try {
        runs = await github.listCheckRuns(repoCoords.owner, repoCoords.repo, headSha);
      } catch (err) {
        if (err instanceof GitHubApiError && err.status === 404) {
          // Commit no longer exists (force-pushed); no point polling further
          this.deps.log.info(`ci-babysitter: commit not found for task ${taskId} (force-pushed?), bailing`, { taskId, workflowId, headSha });
          return;
        }
        this.deps.log.error(`ci-babysitter: listCheckRuns error for task ${taskId}`, { taskId, workflowId, headSha, error: (err as Error).message });
        continue;
      }

      if (signal.aborted) return;

      const elapsedAfterSleep = Date.now() - startMs;

      if (runs.length === 0) {
        if (elapsedAfterSleep > this.cadence.noChecksBailMs) {
          this.deps.log.info(`ci-babysitter: no checks ever observed for task ${taskId}, bailing`, { taskId, workflowId, headSha });
          return;
        }
        lastSeenAllComplete = false;
        continue;
      }

      const allComplete = runs.every((r) => r.status === "completed");
      if (!allComplete) {
        lastSeenAllComplete = false;
        continue;
      }

      if (!lastSeenAllComplete) {
        lastSeenAllComplete = true;
        try {
          await this.sleep(this.cadence.confirmationDelayMs, signal);
        } catch {
          return;
        }
        if (signal.aborted) return;

        let confirmedRuns: typeof runs;
        try {
          confirmedRuns = await github.listCheckRuns(repoCoords.owner, repoCoords.repo, headSha);
        } catch (err) {
          if (err instanceof GitHubApiError && err.status === 404) {
            this.deps.log.info(`ci-babysitter: commit not found during confirmation for task ${taskId} (force-pushed?), bailing`, { taskId, workflowId, headSha });
            return;
          }
          this.deps.log.error(`ci-babysitter: listCheckRuns confirmation error for task ${taskId}`, { taskId, workflowId, headSha, error: (err as Error).message });
          continue;
        }

        if (confirmedRuns.length === 0 || !confirmedRuns.every((r) => r.status === "completed")) {
          lastSeenAllComplete = false;
          continue;
        }

        runs = confirmedRuns;
      }

      const failed = runs.filter((r) => r.conclusion !== undefined && FAILED_CONCLUSIONS.has(r.conclusion));
      if (failed.length === 0) {
        this.deps.log.info(`ci-babysitter: all checks passed for task ${taskId}`, { taskId, workflowId, headSha, prNumber });

        const refreshed = await workflowRepo.get(workflowId);
        const refreshedTask = refreshed?.graph[taskId];
        if (!refreshed || !refreshedTask || refreshedTask.executionStatus !== "pr-open") return;

        if (!refreshed.policy.autoMergeOnGreen) return;
        if (!this.deps.mergeService) return;

        try {
          await this.deps.mergeService.merge({ workflowId, taskId, signal });
          return;
        } catch (err) {
          if (err instanceof MergeAbortedError) return;
          if (err instanceof MergeConflictError) return;
          if (err instanceof MergeServiceError) {
            this.deps.log.error(`ci-babysitter: catastrophic merge failure for ${workflowId}:${taskId}`, { taskId, workflowId, error: (err as Error).message });
            return;
          }
          this.deps.log.error(`ci-babysitter: mergeService.merge threw for ${workflowId}:${taskId}, will not retry`, { taskId, workflowId, error: (err as Error).message });
          return;
        }
      }

      const failureMessage = buildFailureMessage(prNumber, prUrl, failed);

      const report: Artifact = {
        kind: "ci-report",
        ref: JSON.stringify({
          prNumber,
          prUrl,
          headSha,
          failed: failed.map((r) => ({ name: r.name, conclusion: r.conclusion })),
          at: now(),
        }),
        producedBy: "ci-babysitter",
        createdAt: now(),
      };

      try {
        await applyCommand({
          kind: "transition-task",
          workflowId,
          transition: {
            kind: "merge-conflict",
            taskId,
            artifacts: [report],
            reason: "ci_failure",
            now: now(),
          },
        });
      } catch (err) {
        this.deps.log.error(`ci-babysitter: merge-conflict transition failed for task ${taskId}`, { taskId, workflowId, error: (err as Error).message });
        return;
      }

      try {
        await continueTaskService.run({ workflowId, taskId, prompt: failureMessage });
      } catch (err) {
        this.deps.log.error(`ci-babysitter: continueTaskService.run failed for task ${taskId}`, { taskId, workflowId, error: (err as Error).message });
      }

      return;
    }
  }
}

function pickInterval(intervals: PollCadenceInterval[], elapsedMs: number): PollCadenceInterval {
  let selected = intervals[0]!;
  for (const interval of intervals) {
    if (elapsedMs >= interval.afterMs) {
      selected = interval;
    }
  }
  return selected;
}

function buildFailureMessage(
  prNumber: number,
  prUrl: string,
  failed: Array<{ name: string; conclusion?: string; output?: { title?: string; summary?: string; text?: string } }>,
): string {
  const MAX_PER_RUN_TEXT = 2 * 1024;
  const MAX_TOTAL = 16 * 1024;

  const header = `CI is failing on PR #${prNumber} (${prUrl}).\n\nFailure summary:\n`;

  const blocks: string[] = [];
  for (const run of failed) {
    const summary = run.output?.summary ?? run.output?.title ?? "no summary";
    let block = `- ${run.name} [${run.conclusion ?? "unknown"}]: ${summary}`;
    if (run.output?.text) {
      const text = run.output.text.length > MAX_PER_RUN_TEXT
        ? run.output.text.slice(0, MAX_PER_RUN_TEXT) + "\n…[truncated]"
        : run.output.text;
      const indented = text.split("\n").map((l) => `  ${l}`).join("\n");
      block += `\n${indented}`;
    }
    blocks.push(block);
  }

  const footer = "\n\nInvestigate the failure, fix the underlying cause, and push a commit. Do not bypass hooks or skip checks.";

  let message = header + blocks.join("\n") + footer;

  if (message.length > MAX_TOTAL) {
    const truncated = message.slice(0, MAX_TOTAL - "\n…[truncated]".length) + "\n…[truncated]";
    return truncated;
  }

  return message;
}
