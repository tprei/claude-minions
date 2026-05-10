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
}

export class CompletionDispatcher {
  private readonly deps: CompletionDispatcherDeps;
  private readonly activeIterators = new Map<string, AsyncIterator<WorkflowEvent> | null>();
  private readonly taskControllers = new Map<string, AbortController>();

  constructor(deps: CompletionDispatcherDeps) {
    this.deps = deps;
    deps.signal.addEventListener("abort", () => {
      for (const iter of this.activeIterators.values()) {
        if (iter !== null) void iter.return?.();
      }
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

  private async attachAsync(workflowId: string): Promise<void> {
    const cursor = await this.deps.workflowRepo.latestCursor(workflowId);
    const workflow = await this.deps.workflowRepo.get(workflowId);
    if (!workflow) {
      this.activeIterators.delete(workflowId);
      return;
    }
    for (const [taskId, task] of Object.entries(workflow.graph)) {
      if (task.executionStatus === "finalizing") {
        this.spawnDispatchForTask(workflowId, taskId);
      }
    }
    void this.consume(workflowId, cursor);
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
        }
      }
    } catch (err) {
      this.deps.log.error(`completion-dispatcher: consume error for ${workflowId}`, { error: (err as Error).message });
    } finally {
      this.activeIterators.delete(workflowId);
    }
  }

  private async dispatchForTask(workflowId: string, taskId: string, signal: AbortSignal): Promise<void> {
    const { workflowRepo, mergeService } = this.deps;
    const workflow = await workflowRepo.get(workflowId);
    const task = workflow?.graph[taskId];
    if (!workflow || !task) return;
    if (task.executionStatus !== "finalizing") return;

    if (!workflow.policy.autoLand) return;
    if (signal.aborted) return;

    try {
      await mergeService.openOnly({ workflowId, taskId, signal });
    } catch (err) {
      if (err instanceof MergeAbortedError) return;
      if (err instanceof MergeConflictError) return;
      if (err instanceof MergeServiceError) {
        this.deps.log.error(`completion-dispatcher: catastrophic merge failure for ${workflowId}:${taskId}`, { taskId, workflowId, error: (err as Error).message });
        return;
      }
      this.deps.log.error(`completion-dispatcher: openOnly threw for ${workflowId}:${taskId}, leaving in finalizing for retry`, { taskId, workflowId, error: (err as Error).message });
    }
  }
}
