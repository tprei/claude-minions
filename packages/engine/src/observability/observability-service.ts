import type { WorkflowEvent } from "../domain/events.js";
import type { Logger } from "./logger.js";
import type { WorkflowRepository } from "../application/repository.js";

export interface ObservabilityServiceDeps {
  workflowRepo: WorkflowRepository;
  log: Logger;
  signal: AbortSignal;
}

export class ObservabilityService {
  private readonly deps: ObservabilityServiceDeps;
  private readonly activeIterators = new Map<string, AsyncIterator<WorkflowEvent> | null>();

  constructor(deps: ObservabilityServiceDeps) {
    this.deps = deps;
    deps.signal.addEventListener("abort", () => {
      for (const iter of this.activeIterators.values()) {
        if (iter) void iter.return?.();
      }
    });
  }

  attach(workflowId: string): void {
    if (this.activeIterators.has(workflowId)) return;
    this.activeIterators.set(workflowId, null);
    this.deps.log.info("observability attached", {
      kind: "service-attached",
      service: "observability",
      workflowId,
    });
    void this.attachAsync(workflowId);
  }

  detach(workflowId: string): void {
    const iter = this.activeIterators.get(workflowId);
    if (iter) void iter.return?.();
    this.activeIterators.delete(workflowId);
  }

  private async attachAsync(workflowId: string): Promise<void> {
    const cursor = await this.deps.workflowRepo.latestCursor(workflowId);
    void this.consume(workflowId, cursor);
  }

  private async consume(workflowId: string, fromCursor: number): Promise<void> {
    const iterable = this.deps.workflowRepo.subscribe(workflowId, fromCursor);
    const iter = iterable[Symbol.asyncIterator]();
    this.activeIterators.set(workflowId, iter);
    const wfLog = this.deps.log.child({ workflowId });
    try {
      while (true) {
        if (this.deps.signal.aborted) break;
        const result = await iter.next();
        if (result.done) break;
        if (this.deps.signal.aborted) break;
        const event = result.value;
        if (
          (event.kind === "provider-event" || event.kind === "merge-phase") &&
          this.deps.log.level !== "debug"
        ) continue;
        wfLog.info("workflow event", {
          kind: event.kind,
          cursor: event.cursor,
          occurredAt: event.occurredAt,
          ...event.payload,
        });
      }
    } catch (err) {
      wfLog.error("observability consume error", { error: (err as Error).message });
    } finally {
      this.activeIterators.delete(workflowId);
    }
  }
}
