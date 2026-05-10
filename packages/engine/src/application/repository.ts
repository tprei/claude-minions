// The repository assigns cursors to events at save time. applyCommand produces
// events with cursor: 0 as a placeholder; save overwrites with real values.
import { DomainError } from "../domain/errors.js";
import type { WorkflowEvent } from "../domain/events.js";
import type { Workflow } from "../domain/types.js";
import { SubscriberHub } from "../persistence/subscriber-hub.js";
import { hasNonTerminalOperation } from "./recovery.js";

export interface IdempotencyRecord {
  key: string;
  resultRef: string;
}

export interface WorkflowRepository {
  get(workflowId: string): Promise<Workflow | undefined>;
  save(
    workflow: Workflow,
    events: WorkflowEvent[],
    idempotency?: IdempotencyRecord[],
  ): Promise<void>;
  eventsSince(workflowId: string, cursor: number): Promise<WorkflowEvent[]>;
  latestCursor(workflowId: string): Promise<number>;
  subscribe(workflowId: string, fromCursor: number): AsyncIterable<WorkflowEvent>;
  publishTransient(workflowId: string, event: Extract<WorkflowEvent, { kind: "provider-event" | "merge-phase" }>): void;
  lookupIdempotency(workflowId: string, key: string): Promise<string | undefined>;
  listRecoverable(): Promise<Workflow[]>;
  list(opts?: { includeCompleted?: boolean }): Promise<Workflow[]>;
}

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private readonly workflows = new Map<string, Workflow>();
  private readonly events = new Map<string, WorkflowEvent[]>();
  private readonly idempotency = new Map<string, Map<string, string>>();
  private readonly hub = new SubscriberHub();

  async get(workflowId: string): Promise<Workflow | undefined> {
    return this.workflows.get(workflowId);
  }

  async save(
    workflow: Workflow,
    events: WorkflowEvent[],
    idempotency?: IdempotencyRecord[],
  ): Promise<void> {
    const existing = this.workflows.get(workflow.id);

    if (existing !== undefined) {
      if (existing.version !== workflow.version - 1) {
        throw new DomainError("version_conflict", "workflow version conflict on save", {
          workflowId: workflow.id,
          existingVersion: existing.version,
          incomingVersion: workflow.version,
        });
      }
    }

    const workflowEvents = this.events.get(workflow.id) ?? [];
    const nextCursor = workflowEvents.length > 0
      ? (workflowEvents[workflowEvents.length - 1]?.cursor ?? 0)
      : 0;

    const stamped = events.map((event, i) => ({ ...event, cursor: nextCursor + i + 1 }));

    this.workflows.set(workflow.id, workflow);
    this.events.set(workflow.id, [...workflowEvents, ...stamped]);

    if (idempotency) {
      for (const record of idempotency) {
        let keyMap = this.idempotency.get(workflow.id);
        if (!keyMap) {
          keyMap = new Map();
          this.idempotency.set(workflow.id, keyMap);
        }
        keyMap.set(record.key, record.resultRef);
      }
    }

    this.hub.notify(workflow.id, stamped);
  }

  async eventsSince(workflowId: string, cursor: number): Promise<WorkflowEvent[]> {
    const workflowEvents = this.events.get(workflowId) ?? [];
    return workflowEvents.filter((e) => e.cursor > cursor);
  }

  async latestCursor(workflowId: string): Promise<number> {
    const workflowEvents = this.events.get(workflowId) ?? [];
    return workflowEvents.length > 0 ? (workflowEvents[workflowEvents.length - 1]?.cursor ?? 0) : 0;
  }

  subscribe(workflowId: string, fromCursor: number): AsyncIterable<WorkflowEvent> {
    return this.hub.subscribe(workflowId, fromCursor, () =>
      this.eventsSince(workflowId, fromCursor),
    );
  }

  publishTransient(workflowId: string, event: Extract<WorkflowEvent, { kind: "provider-event" | "merge-phase" }>): void {
    this.hub.notifyTransient(workflowId, event);
  }

  subscriberCount(workflowId: string): number {
    return this.hub.subscriberCount(workflowId);
  }

  async lookupIdempotency(workflowId: string, key: string): Promise<string | undefined> {
    return this.idempotency.get(workflowId)?.get(key);
  }

  async listRecoverable(): Promise<Workflow[]> {
    return Array.from(this.workflows.values()).filter(
      (w) => w.status !== "completed" || hasNonTerminalOperation(w),
    );
  }

  async list(opts?: { includeCompleted?: boolean }): Promise<Workflow[]> {
    return [...this.workflows.values()]
      .filter((w) => opts?.includeCompleted === true || w.status === "active")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
