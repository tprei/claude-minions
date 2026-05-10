import Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import { DomainError } from "../domain/errors.js";
import type { WorkflowEvent } from "../domain/events.js";
import type { Workflow } from "../domain/types.js";
import type { IdempotencyRecord, WorkflowRepository } from "../application/repository.js";
import { hasNonTerminalOperation } from "../application/recovery.js";
import {
  SCHEMA_DDL,
  SQL_EVENTS_SINCE,
  SQL_GET_VERSION,
  SQL_GET_WORKFLOW,
  SQL_INSERT_EVENT,
  SQL_INSERT_IDEMPOTENCY,
  SQL_LIST_ACTIVE_ORDERED,
  SQL_LIST_ALL_ORDERED,
  SQL_LIST_COMPLETED,
  SQL_LIST_NON_COMPLETED,
  SQL_LOOKUP_IDEMPOTENCY,
  SQL_MAX_CURSOR,
  SQL_UPSERT_WORKFLOW,
} from "./schema.js";
import { SubscriberHub } from "./subscriber-hub.js";

interface WorkflowRow {
  blob: string;
}

interface EventRow {
  workflow_id: string;
  cursor: number;
  kind: string;
  occurred_at: string;
  payload: string;
}

interface VersionRow {
  version: number | null;
}

interface CursorRow {
  max_cursor: number | null;
}

interface IdempotencyRow {
  result_ref: string;
}

export class SQLiteWorkflowRepository implements WorkflowRepository {
  private readonly db: Database.Database;
  private readonly hub = new SubscriberHub();

  private readonly stmtGetWorkflow: Statement<[string], WorkflowRow>;
  private readonly stmtGetVersion: Statement<[string], VersionRow>;
  private readonly stmtUpsertWorkflow: Statement<[string, string, number, string]>;
  private readonly stmtMaxCursor: Statement<[string], CursorRow>;
  private readonly stmtInsertEvent: Statement<[string, number, string, string, string]>;
  private readonly stmtInsertIdempotency: Statement<[string, string, string]>;
  private readonly stmtEventsSince: Statement<[string, number], EventRow>;
  private readonly stmtLookupIdempotency: Statement<[string, string], IdempotencyRow>;
  private readonly stmtListNonCompleted: Statement<[], WorkflowRow>;
  private readonly stmtListCompleted: Statement<[], WorkflowRow>;
  private readonly stmtListActiveOrdered: Statement<[], WorkflowRow>;
  private readonly stmtListAllOrdered: Statement<[], WorkflowRow>;
  private readonly txSave: (
    workflow: Workflow,
    events: WorkflowEvent[],
    idempotency: IdempotencyRecord[],
  ) => WorkflowEvent[];

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA_DDL);

    this.stmtGetWorkflow = this.db.prepare<[string], WorkflowRow>(SQL_GET_WORKFLOW);
    this.stmtGetVersion = this.db.prepare<[string], VersionRow>(SQL_GET_VERSION);
    this.stmtUpsertWorkflow = this.db.prepare<[string, string, number, string]>(SQL_UPSERT_WORKFLOW);
    this.stmtMaxCursor = this.db.prepare<[string], CursorRow>(SQL_MAX_CURSOR);
    this.stmtInsertEvent =
      this.db.prepare<[string, number, string, string, string]>(SQL_INSERT_EVENT);
    this.stmtInsertIdempotency = this.db.prepare<[string, string, string]>(SQL_INSERT_IDEMPOTENCY);
    this.stmtEventsSince = this.db.prepare<[string, number], EventRow>(SQL_EVENTS_SINCE);
    this.stmtLookupIdempotency =
      this.db.prepare<[string, string], IdempotencyRow>(SQL_LOOKUP_IDEMPOTENCY);
    this.stmtListNonCompleted = this.db.prepare<[], WorkflowRow>(SQL_LIST_NON_COMPLETED);
    this.stmtListCompleted = this.db.prepare<[], WorkflowRow>(SQL_LIST_COMPLETED);
    this.stmtListActiveOrdered = this.db.prepare<[], WorkflowRow>(SQL_LIST_ACTIVE_ORDERED);
    this.stmtListAllOrdered = this.db.prepare<[], WorkflowRow>(SQL_LIST_ALL_ORDERED);

    this.txSave = this.db.transaction(
      (workflow: Workflow, events: WorkflowEvent[], idempotency: IdempotencyRecord[]) => {
        const versionRow = this.stmtGetVersion.get(workflow.id);

        if (versionRow !== undefined && versionRow.version !== null) {
          if (versionRow.version !== workflow.version - 1) {
            throw new DomainError("version_conflict", "workflow version conflict on save", {
              workflowId: workflow.id,
              existingVersion: versionRow.version,
              incomingVersion: workflow.version,
            });
          }
        }

        this.stmtUpsertWorkflow.run(
          workflow.id,
          workflow.status,
          workflow.version,
          JSON.stringify(workflow),
        );

        const cursorRow = this.stmtMaxCursor.get(workflow.id)!;
        let nextCursor = cursorRow.max_cursor ?? 0;

        const stamped = events.map((event) => {
          nextCursor += 1;
          return { ...event, cursor: nextCursor };
        });

        for (const event of stamped) {
          this.stmtInsertEvent.run(
            event.workflowId,
            event.cursor,
            event.kind,
            event.occurredAt,
            JSON.stringify(event.payload),
          );
        }

        for (const record of idempotency) {
          try {
            this.stmtInsertIdempotency.run(workflow.id, record.key, record.resultRef);
          } catch (err) {
            if (
              err instanceof Error &&
              err.message.includes("UNIQUE constraint failed")
            ) {
              throw new DomainError("idempotency_collision", "idempotency key already exists", {
                workflowId: workflow.id,
                key: record.key,
              });
            }
            throw err;
          }
        }

        return stamped;
      },
    );
  }

  async get(workflowId: string): Promise<Workflow | undefined> {
    const row = this.stmtGetWorkflow.get(workflowId);
    if (!row) return undefined;
    return JSON.parse(row.blob) as Workflow;
  }

  async save(
    workflow: Workflow,
    events: WorkflowEvent[],
    idempotency?: IdempotencyRecord[],
  ): Promise<void> {
    const stamped = this.txSave(workflow, events, idempotency ?? []);
    this.hub.notify(workflow.id, stamped);
  }

  async eventsSince(workflowId: string, cursor: number): Promise<WorkflowEvent[]> {
    const rows = this.stmtEventsSince.all(workflowId, cursor);
    return rows.map((row) => ({
      workflowId: row.workflow_id,
      cursor: row.cursor,
      kind: row.kind as WorkflowEvent["kind"],
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload) as WorkflowEvent["payload"],
    })) as WorkflowEvent[];
  }

  async latestCursor(workflowId: string): Promise<number> {
    const row = this.stmtMaxCursor.get(workflowId)!;
    return row.max_cursor ?? 0;
  }

  subscribe(workflowId: string, fromCursor: number): AsyncIterable<WorkflowEvent> {
    return this.hub.subscribe(workflowId, fromCursor, () =>
      this.eventsSince(workflowId, fromCursor),
    );
  }

  publishTransient(workflowId: string, event: Extract<WorkflowEvent, { kind: "provider-event" | "merge-phase" }>): void {
    this.hub.notifyTransient(workflowId, event);
  }

  async lookupIdempotency(workflowId: string, key: string): Promise<string | undefined> {
    const row = this.stmtLookupIdempotency.get(workflowId, key);
    return row?.result_ref;
  }

  async listRecoverable(): Promise<Workflow[]> {
    const nonCompleted = this.stmtListNonCompleted
      .all()
      .map((row) => JSON.parse(row.blob) as Workflow);
    const completedWithOps = this.stmtListCompleted
      .all()
      .map((row) => JSON.parse(row.blob) as Workflow)
      .filter(hasNonTerminalOperation);
    return [...nonCompleted, ...completedWithOps];
  }

  async list(opts?: { includeCompleted?: boolean }): Promise<Workflow[]> {
    const stmt = opts?.includeCompleted === true
      ? this.stmtListAllOrdered
      : this.stmtListActiveOrdered;
    return stmt.all().map((row) => JSON.parse(row.blob) as Workflow);
  }

  subscriberCount(workflowId: string): number {
    return this.hub.subscriberCount(workflowId);
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
