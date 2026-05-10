import type { WorkflowEvent } from "../domain/events.js";
import type { Command, CommandResult } from "./commands.js";
import type { WorkflowRepository } from "./repository.js";
import type { Logger } from "../observability/logger.js";

export interface LocalFinalizeServiceDeps {
  workflowRepo: WorkflowRepository;
  applyCommand: (cmd: Command) => Promise<CommandResult>;
  signal: AbortSignal;
  now: () => string;
  log: Logger;
}

export class LocalFinalizeService {
  private readonly deps: LocalFinalizeServiceDeps;
  private readonly activeIterators = new Map<string, AsyncIterator<WorkflowEvent> | null>();

  constructor(deps: LocalFinalizeServiceDeps) {
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

  detach(workflowId: string): void {
    const iter = this.activeIterators.get(workflowId);
    if (iter) void iter.return?.();
    this.activeIterators.delete(workflowId);
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
        void this.finalizeTask(workflowId, taskId);
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
          void this.finalizeTask(workflowId, taskId);
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

  private async finalizeTask(workflowId: string, taskId: string): Promise<void> {
    if (this.deps.signal.aborted) return;
    try {
      await this.deps.applyCommand({
        kind: "transition-task",
        workflowId,
        transition: {
          kind: "complete-without-pr",
          taskId,
          now: this.deps.now(),
        },
      });
    } catch (err) {
      this.deps.log.error(`local-finalize-service: transition error for ${workflowId}:${taskId}`, {
        error: (err as Error).message,
      });
    }
  }
}
