import type { WorkflowEvent } from "../domain/events.js";
import type { Logger } from "../observability/logger.js";
import type { ContinueTaskService } from "./continue-task-service.js";
import type { WorkflowRepository } from "./repository.js";
import type { RetryTaskService } from "./retry-task-service.js";
import { planDispatch } from "./scheduler.js";
import type { TaskNode } from "../domain/types.js";

export interface SchedulerServiceDeps {
  repo: WorkflowRepository;
  retry: RetryTaskService;
  continueService?: ContinueTaskService;
  log: Logger;
  signal: AbortSignal;
  nowMs?: () => number;
  dispatchBackoffMs?: number;
}

function priorSessionRef(task: TaskNode): string | undefined {
  for (let i = task.runs.length - 1; i >= 0; i--) {
    const run = task.runs[i];
    if (run && run.endedAt !== undefined && run.providerSessionRef !== undefined && run.providerSessionRef !== "") {
      return run.providerSessionRef;
    }
  }
  return undefined;
}

export class SchedulerService {
  private static readonly DEFAULT_DISPATCH_BACKOFF_MS = 300_000;

  private readonly deps: SchedulerServiceDeps;
  private readonly activeIterators = new Map<string, AsyncIterator<WorkflowEvent> | null>();
  private readonly inFlight = new Set<string>();
  private readonly failures = new Map<string, { signature: string; count: number; backoffUntilMs: number }>();

  constructor(deps: SchedulerServiceDeps) {
    this.deps = deps;
    deps.signal.addEventListener("abort", () => {
      for (const iter of this.activeIterators.values()) {
        if (iter !== null) void iter.return?.();
      }
      this.activeIterators.clear();
    });
  }

  attach(workflowId: string): void {
    if (this.activeIterators.has(workflowId)) return;
    this.activeIterators.set(workflowId, null);
    void this.attachAsync(workflowId);
  }

  getStats(): { attachedWorkflows: number; inFlight: number; failures: number } {
    return {
      attachedWorkflows: this.activeIterators.size,
      inFlight: this.inFlight.size,
      failures: this.failures.size,
    };
  }

  private async attachAsync(workflowId: string): Promise<void> {
    const cursor = await this.deps.repo.latestCursor(workflowId);
    const workflow = await this.deps.repo.get(workflowId);
    if (!workflow) {
      this.activeIterators.delete(workflowId);
      return;
    }
    void this.dispatchPending(workflowId);
    void this.consume(workflowId, cursor);
  }

  private async consume(workflowId: string, fromCursor: number): Promise<void> {
    const iterable = this.deps.repo.subscribe(workflowId, fromCursor);
    const iter = iterable[Symbol.asyncIterator]();
    this.activeIterators.set(workflowId, iter);
    try {
      while (true) {
        if (this.deps.signal.aborted) break;
        const result = await iter.next();
        if (result.done) break;
        if (this.deps.signal.aborted) break;

        const event = result.value;
        if (event.kind === "task-transitioned") {
          void this.dispatchPending(workflowId);
        }
      }
    } catch (err) {
      this.deps.log.error("scheduler-service: consume error", {
        workflowId,
        error: (err as Error).message,
      });
    } finally {
      this.activeIterators.delete(workflowId);
    }
  }

  private pruneFailuresForWorkflow(workflowId: string): void {
    const prefix = `${workflowId}:`;
    for (const key of this.failures.keys()) {
      if (key.startsWith(prefix)) this.failures.delete(key);
    }
  }

  private async dispatchPending(workflowId: string): Promise<void> {
    if (this.deps.signal.aborted) return;
    const workflow = await this.deps.repo.get(workflowId);
    // Prune failure entries only when the workflow is actually gone (deleted) or
    // terminal — not on transient consume errors, which would wipe legitimate
    // backoff state and cause a re-dispatch storm.
    if (!workflow || workflow.status !== "active") {
      this.pruneFailuresForWorkflow(workflowId);
      return;
    }

    const candidates = planDispatch(workflow);
    for (const { task } of candidates) {
      const key = `${workflowId}:${task.id}`;
      if (this.inFlight.has(key)) continue;
      if (this.isBackedOff(key)) continue;

      this.inFlight.add(key);

      // The freshness re-read can throw (SQLITE_BUSY/disk/closed). Keep the inFlight
      // claim alive only for a successful dispatch: on any thrown error OR a
      // stale/not-pending result, release the key and move to the next candidate so
      // one bad read neither aborts the whole loop nor leaks the key forever.
      let freshTask: TaskNode | undefined;
      try {
        const fresh = await this.deps.repo.get(workflowId);
        freshTask = fresh?.graph[task.id];
      } catch (err) {
        this.inFlight.delete(key);
        this.deps.log.warn("scheduler-service: freshness read failed", {
          workflowId,
          taskId: task.id,
          error: (err as Error).message,
        });
        continue;
      }

      if (!freshTask || freshTask.executionStatus !== "pending") {
        this.inFlight.delete(key);
        continue;
      }

      // Prefer continue (--resume) over retry (fresh) when the prior run captured a
      // providerSessionRef. Lets a task survive a tmux/container restart without losing
      // the agent's conversation memory.
      const resumeRef = priorSessionRef(freshTask);
      const dispatch = resumeRef !== undefined && this.deps.continueService !== undefined
        ? this.deps.continueService.run({ workflowId, taskId: task.id, prompt: task.prompt })
        : this.deps.retry.run({ workflowId, taskId: task.id, prompt: task.prompt });
      void dispatch
        .then(() => {
          this.failures.delete(key);
        })
        .catch((err: unknown) => {
          this.recordDispatchFailure(key, err);
          this.deps.log.warn("scheduler-service: dispatch failed", {
            workflowId,
            taskId: task.id,
            error: (err as Error).message,
          });
        })
        .finally(() => {
          this.inFlight.delete(key);
        });
    }
  }

  private isBackedOff(key: string): boolean {
    const failure = this.failures.get(key);
    return failure !== undefined && failure.backoffUntilMs > this.nowMs();
  }

  private recordDispatchFailure(key: string, err: unknown): void {
    const signature = err instanceof Error ? `${err.name}:${err.message}` : String(err);
    const previous = this.failures.get(key);
    const count = previous?.signature === signature ? previous.count + 1 : 1;
    const backoffUntilMs = count >= 2
      ? this.nowMs() + (this.deps.dispatchBackoffMs ?? SchedulerService.DEFAULT_DISPATCH_BACKOFF_MS)
      : 0;
    this.failures.set(key, { signature, count, backoffUntilMs });
  }

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }
}
