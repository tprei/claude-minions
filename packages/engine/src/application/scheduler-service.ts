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
  private readonly deps: SchedulerServiceDeps;
  private readonly activeIterators = new Map<string, AsyncIterator<WorkflowEvent> | null>();
  private readonly inFlight = new Set<string>();

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

  private async dispatchPending(workflowId: string): Promise<void> {
    if (this.deps.signal.aborted) return;
    const workflow = await this.deps.repo.get(workflowId);
    if (!workflow) return;

    const candidates = planDispatch(workflow);
    for (const { task } of candidates) {
      const key = `${workflowId}:${task.id}`;
      if (this.inFlight.has(key)) continue;

      const fresh = await this.deps.repo.get(workflowId);
      const freshTask = fresh?.graph[task.id];
      if (!freshTask || freshTask.executionStatus !== "pending") continue;

      this.inFlight.add(key);
      // Prefer continue (--resume) over retry (fresh) when the prior run captured a
      // providerSessionRef. Lets a task survive a tmux/container restart without losing
      // the agent's conversation memory.
      const resumeRef = priorSessionRef(freshTask);
      const dispatch = resumeRef !== undefined && this.deps.continueService !== undefined
        ? this.deps.continueService.run({ workflowId, taskId: task.id, prompt: task.prompt })
        : this.deps.retry.run({ workflowId, taskId: task.id, prompt: task.prompt });
      void dispatch
        .catch((err: unknown) => {
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
}
