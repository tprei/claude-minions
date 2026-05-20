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
  private readonly activeIterators = new Map<string, { iterator: AsyncIterator<WorkflowEvent> | null }>();

  constructor(deps: ObservabilityServiceDeps) {
    this.deps = deps;
    deps.signal.addEventListener("abort", () => {
      for (const attachment of this.activeIterators.values()) {
        if (attachment.iterator) void attachment.iterator.return?.();
      }
      this.activeIterators.clear();
    });
  }

  attach(workflowId: string): void {
    if (this.activeIterators.has(workflowId)) return;
    const attachment = { iterator: null };
    this.activeIterators.set(workflowId, attachment);
    this.deps.log.info("observability attached", {
      kind: "service-attached",
      service: "observability",
      workflowId,
    });
    void this.attachAsync(workflowId, attachment);
  }

  detach(workflowId: string): void {
    const attachment = this.activeIterators.get(workflowId);
    if (attachment?.iterator) void attachment.iterator.return?.();
    this.activeIterators.delete(workflowId);
  }

  private isAttached(workflowId: string, attachment: { iterator: AsyncIterator<WorkflowEvent> | null }): boolean {
    return !this.deps.signal.aborted && this.activeIterators.get(workflowId) === attachment;
  }

  private async attachAsync(workflowId: string, attachment: { iterator: AsyncIterator<WorkflowEvent> | null }): Promise<void> {
    const cursor = await this.deps.workflowRepo.latestCursor(workflowId);
    if (!this.isAttached(workflowId, attachment)) return;
    void this.consume(workflowId, cursor, attachment);
  }

  private async consume(workflowId: string, fromCursor: number, attachment: { iterator: AsyncIterator<WorkflowEvent> | null }): Promise<void> {
    const iterable = this.deps.workflowRepo.subscribe(workflowId, fromCursor);
    const iter = iterable[Symbol.asyncIterator]();
    if (!this.isAttached(workflowId, attachment)) {
      void iter.return?.();
      return;
    }
    attachment.iterator = iter;
    const wfLog = this.deps.log.child({ workflowId });
    try {
      while (true) {
        if (!this.isAttached(workflowId, attachment)) break;
        const result = await iter.next();
        if (result.done) break;
        if (!this.isAttached(workflowId, attachment)) break;
        const event = result.value;
        if (
          (event.kind === "provider-event" || event.kind === "merge-phase" || event.kind === "ci-poll-result") &&
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
      if (this.activeIterators.get(workflowId) === attachment) this.activeIterators.delete(workflowId);
    }
  }
}
