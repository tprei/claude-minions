import type { WorkflowEvent } from "../domain/events.js";
import type { Command, CommandResult } from "./commands.js";
import { MergeAbortedError, MergeConflictError, MergeService, MergeServiceError } from "./merge-service.js";
import type { WorkflowRepository } from "./repository.js";
import type { Logger } from "../observability/logger.js";

export interface CompletionDispatcherDeps {
  workflowRepo: WorkflowRepository;
  applyCommand: (cmd: Command) => Promise<CommandResult>;
  mergeService: MergeService;
  signal: AbortSignal;
  now: () => string;
  log: Logger;
  shouldDispatch?: (repoId: string) => boolean;
  retryDelayMs?: number;
}

export class CompletionDispatcher {
  private static readonly DEFAULT_RETRY_DELAY_MS = 30_000;
  private readonly deps: CompletionDispatcherDeps;
  private readonly activeIterators = new Map<string, { iterator: AsyncIterator<WorkflowEvent> | null }>();
  private readonly taskControllers = new Map<string, AbortController>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: CompletionDispatcherDeps) {
    this.deps = deps;
    deps.signal.addEventListener("abort", () => {
      for (const attachment of this.activeIterators.values()) {
        if (attachment.iterator !== null) void attachment.iterator.return?.();
      }
      this.activeIterators.clear();
      for (const ctrl of this.taskControllers.values()) ctrl.abort();
      this.taskControllers.clear();
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
    for (const key of this.taskControllers.keys()) {
      if (key.startsWith(`${workflowId}:`)) {
        this.taskControllers.get(key)?.abort();
        this.taskControllers.delete(key);
      }
    }
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
        this.spawnDispatchForTask(workflowId, taskId);
      }
    }
    void this.consume(workflowId, cursor, attachment);
  }

  private spawnDispatchForTask(workflowId: string, taskId: string): void {
    const key = `${workflowId}:${taskId}`;
    if (this.taskControllers.has(key)) return;
    const ctrl = new AbortController();
    this.taskControllers.set(key, ctrl);
    void this.dispatchForTask(workflowId, taskId, ctrl.signal)
      .catch((err) => this.deps.log.error(`completion-dispatcher: dispatchForTask error for ${key}`, { error: (err as Error).message }))
      .finally(() => {
        if (this.taskControllers.get(key) === ctrl) this.taskControllers.delete(key);
      });
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
          this.spawnDispatchForTask(workflowId, taskId);
        } else if (from === "finalizing" && to !== "finalizing") {
          const ctrl = this.taskControllers.get(key);
          if (ctrl) {
            ctrl.abort();
            this.taskControllers.delete(key);
          }
          this.clearRetryTimer(key);
        }
      }
    } catch (err) {
      this.deps.log.error(`completion-dispatcher: consume error for ${workflowId}`, { error: (err as Error).message });
    } finally {
      if (this.activeIterators.get(workflowId) === attachment) this.activeIterators.delete(workflowId);
    }
  }

  private async dispatchForTask(workflowId: string, taskId: string, signal: AbortSignal): Promise<void> {
    const { workflowRepo, mergeService } = this.deps;
    const workflow = await workflowRepo.get(workflowId);
    const task = workflow?.graph[taskId];
    if (!workflow || !task) return;
    if (task.executionStatus !== "finalizing") return;
    if (this.deps.shouldDispatch !== undefined && !this.deps.shouldDispatch(workflow.repoId)) return;

    // Always open the PR on completion — that's pure observability. autoLand
    // only governs whether the engine *merges* the PR after CI passes (which
    // is the CIBabysitterService's job, gated separately). Previously this
    // checked `!autoLand` here and bailed, trapping every task in finalizing
    // forever with no UI signal that anything was wrong.
    if (signal.aborted) return;

    try {
      await mergeService.openOnly({ workflowId, taskId, signal });
      this.clearRetryTimer(`${workflowId}:${taskId}`);
    } catch (err) {
      if (err instanceof MergeAbortedError) return;
      if (err instanceof MergeConflictError) return;
      if (err instanceof MergeServiceError) {
        this.deps.log.error(`completion-dispatcher: catastrophic merge failure for ${workflowId}:${taskId}`, { taskId, workflowId, error: (err as Error).message });
        return;
      }
      this.deps.log.error(`completion-dispatcher: openOnly threw for ${workflowId}:${taskId}, leaving in finalizing for retry`, { taskId, workflowId, error: (err as Error).message });
      this.scheduleRetry(`${workflowId}:${taskId}`, workflowId, taskId);
    }
  }

  private scheduleRetry(key: string, workflowId: string, taskId: string): void {
    this.clearRetryTimer(key);
    if (this.deps.signal.aborted) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      if (this.deps.signal.aborted || !this.activeIterators.has(workflowId)) return;
      this.spawnDispatchForTask(workflowId, taskId);
    }, this.deps.retryDelayMs ?? CompletionDispatcher.DEFAULT_RETRY_DELAY_MS);
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
