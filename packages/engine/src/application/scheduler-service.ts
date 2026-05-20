import type { WorkflowEvent } from "../domain/events.js";
import type { Logger } from "../observability/logger.js";
import type { Command, CommandResult } from "./commands.js";
import type { ContinueTaskService } from "./continue-task-service.js";
import type { WorkflowRepository } from "./repository.js";
import type { RetryTaskService } from "./retry-task-service.js";
import { planDispatch } from "./scheduler.js";
import type { TaskNode } from "../domain/types.js";

export interface SchedulerServiceDeps {
  repo: WorkflowRepository;
  retry: RetryTaskService;
  continueService?: ContinueTaskService;
  applyCommand?: (cmd: Command) => Promise<CommandResult>;
  log: Logger;
  signal: AbortSignal;
  now?: () => string;
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
  private readonly activeIterators = new Map<string, { iterator: AsyncIterator<WorkflowEvent> | null }>();
  private readonly inFlight = new Set<string>();
  private readonly failures = new Map<string, { signature: string; count: number; backoffUntilMs: number }>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: SchedulerServiceDeps) {
    this.deps = deps;
    deps.signal.addEventListener("abort", () => {
      for (const attachment of this.activeIterators.values()) {
        if (attachment.iterator !== null) void attachment.iterator.return?.();
      }
      this.activeIterators.clear();
      this.inFlight.clear();
      this.failures.clear();
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
    for (const key of this.inFlight) {
      if (key.startsWith(`${workflowId}:`)) this.inFlight.delete(key);
    }
    for (const key of this.failures.keys()) {
      if (key.startsWith(`${workflowId}:`)) this.failures.delete(key);
    }
    for (const key of this.retryTimers.keys()) {
      if (key.startsWith(`${workflowId}:`)) this.clearRetryTimer(key);
    }
  }

  getStats(): { attachedWorkflows: number; inFlight: number } {
    return {
      attachedWorkflows: this.activeIterators.size,
      inFlight: this.inFlight.size,
    };
  }

  private isAttached(workflowId: string, attachment: { iterator: AsyncIterator<WorkflowEvent> | null }): boolean {
    return !this.deps.signal.aborted && this.activeIterators.get(workflowId) === attachment;
  }

  private async attachAsync(workflowId: string, attachment: { iterator: AsyncIterator<WorkflowEvent> | null }): Promise<void> {
    const cursor = await this.deps.repo.latestCursor(workflowId);
    if (!this.isAttached(workflowId, attachment)) return;
    const workflow = await this.deps.repo.get(workflowId);
    if (!this.isAttached(workflowId, attachment)) return;
    if (!workflow) {
      if (this.activeIterators.get(workflowId) === attachment) this.activeIterators.delete(workflowId);
      return;
    }
    void this.dispatchPending(workflowId);
    void this.consume(workflowId, cursor, attachment);
  }

  private async consume(workflowId: string, fromCursor: number, attachment: { iterator: AsyncIterator<WorkflowEvent> | null }): Promise<void> {
    const iterable = this.deps.repo.subscribe(workflowId, fromCursor);
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
      if (this.activeIterators.get(workflowId) === attachment) this.activeIterators.delete(workflowId);
    }
  }

  private async dispatchPending(workflowId: string): Promise<void> {
    if (this.deps.signal.aborted) return;
    const workflow = await this.deps.repo.get(workflowId);
    if (!workflow) return;

    const candidates = planDispatch(workflow);
    for (const { task } of candidates) {
      const key = `${workflowId}:${task.id}`;
      if (this.inFlight.has(key)) continue;
      if (this.isBackedOff(key)) continue;
      this.inFlight.add(key);

      let dispatch: Promise<unknown> | undefined;
      try {
        const fresh = await this.deps.repo.get(workflowId);
        const freshTask = fresh?.graph[task.id];
        if (!freshTask || freshTask.executionStatus !== "pending") {
          this.inFlight.delete(key);
          continue;
        }
        // Prefer continue (--resume) over retry (fresh) when the prior run captured a
        // providerSessionRef. Lets a task survive a tmux/container restart without losing
        // the agent's conversation memory.
        const resumeRef = priorSessionRef(freshTask);
        dispatch = resumeRef !== undefined && this.deps.continueService !== undefined
          ? this.deps.continueService.run({ workflowId, taskId: task.id, prompt: task.prompt })
          : this.deps.retry.run({ workflowId, taskId: task.id, prompt: task.prompt });
      } catch (err) {
        this.inFlight.delete(key);
        await this.recoverDispatchFailure(workflowId, task.id);
        const retryDelayMs = this.recordDispatchFailure(key, err);
        this.scheduleRetry(key, workflowId, retryDelayMs);
        this.deps.log.warn("scheduler-service: dispatch setup failed", {
          workflowId,
          taskId: task.id,
          error: (err as Error).message,
        });
      }
      if (dispatch === undefined) continue;
      void dispatch
        .then(() => {
          this.failures.delete(key);
          this.clearRetryTimer(key);
        })
        .catch(async (err: unknown) => {
          await this.recoverDispatchFailure(workflowId, task.id);
          const retryDelayMs = this.recordDispatchFailure(key, err);
          this.scheduleRetry(key, workflowId, retryDelayMs);
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

  private recordDispatchFailure(key: string, err: unknown): number {
    const signature = err instanceof Error ? `${err.name}:${err.message}` : String(err);
    const previous = this.failures.get(key);
    const count = previous !== undefined ? previous.count + 1 : 1;
    const retryDelayMs = count >= 2 ? (this.deps.dispatchBackoffMs ?? SchedulerService.DEFAULT_DISPATCH_BACKOFF_MS) : 0;
    const backoffUntilMs = retryDelayMs > 0 ? this.nowMs() + retryDelayMs : 0;
    this.failures.set(key, { signature, count, backoffUntilMs });
    return retryDelayMs;
  }

  private scheduleRetry(key: string, workflowId: string, delayMs: number): void {
    this.clearRetryTimer(key);
    if (this.deps.signal.aborted) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      if (this.deps.signal.aborted || !this.activeIterators.has(workflowId)) return;
      void this.dispatchPending(workflowId);
    }, delayMs);
    this.retryTimers.set(key, timer);
  }

  private async recoverDispatchFailure(workflowId: string, taskId: string): Promise<void> {
    if (this.deps.applyCommand === undefined) return;

    const workflow = await this.deps.repo.get(workflowId);
    const task = workflow?.graph[taskId];
    if (!task || task.executionStatus !== "ready") return;

    try {
      await this.deps.applyCommand({
        kind: "transition-task",
        workflowId,
        transition: {
          kind: "recover-task",
          taskId,
          now: this.now(),
        },
      });
    } catch (err) {
      this.deps.log.warn("scheduler-service: failed to recover task after dispatch error", {
        workflowId,
        taskId,
        error: (err as Error).message,
      });
    }
  }

  private clearRetryTimer(key: string): void {
    const timer = this.retryTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retryTimers.delete(key);
    }
  }

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }
}
