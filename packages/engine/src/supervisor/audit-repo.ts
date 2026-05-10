import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import type { AuditEvent } from "./alert.js";
import {
  AUDIT_SCHEMA_DDL,
  SQL_INSERT_AUDIT_EVENT,
  SQL_LIST_AUDIT_EVENTS,
  SQL_LIST_AUDIT_EVENTS_BEFORE,
  SQL_LIST_AUDIT_EVENTS_ACTION,
  SQL_LIST_AUDIT_EVENTS_ACTION_BEFORE,
  SQL_LIST_AUDIT_EVENTS_WORKFLOW,
  SQL_LIST_AUDIT_EVENTS_WORKFLOW_BEFORE,
} from "../persistence/audit-schema.js";

interface AuditRow {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  workflow_id: string | null;
  task_id: string | null;
  target_kind: string | null;
  target_id: string | null;
  detail: string | null;
}

function rowToEvent(row: AuditRow): AuditEvent {
  const event: AuditEvent = {
    id: row.id,
    timestamp: row.timestamp,
    actor: row.actor,
    action: row.action,
  };
  if (row.workflow_id !== null) event.workflowId = row.workflow_id;
  if (row.task_id !== null) event.taskId = row.task_id;
  if (row.target_kind !== null) event.targetKind = row.target_kind;
  if (row.target_id !== null) event.targetId = row.target_id;
  if (row.detail !== null) event.detail = JSON.parse(row.detail) as Record<string, unknown>;
  return event;
}

export interface AuditListOpts {
  limit?: number;
  beforeTs?: string;
  action?: string;
  workflowId?: string;
}

export class AuditRepo {
  private readonly stmtInsert: Statement<[string, string, string, string, string | null, string | null, string | null, string | null, string | null]>;
  private readonly stmtList: Statement<[number], AuditRow>;
  private readonly stmtListBefore: Statement<[string, number], AuditRow>;
  private readonly stmtListAction: Statement<[string, number], AuditRow>;
  private readonly stmtListActionBefore: Statement<[string, string, number], AuditRow>;
  private readonly stmtListWorkflow: Statement<[string, number], AuditRow>;
  private readonly stmtListWorkflowBefore: Statement<[string, string, number], AuditRow>;

  constructor(db: Database.Database) {
    db.exec(AUDIT_SCHEMA_DDL);
    this.stmtInsert = db.prepare(SQL_INSERT_AUDIT_EVENT);
    this.stmtList = db.prepare(SQL_LIST_AUDIT_EVENTS);
    this.stmtListBefore = db.prepare(SQL_LIST_AUDIT_EVENTS_BEFORE);
    this.stmtListAction = db.prepare(SQL_LIST_AUDIT_EVENTS_ACTION);
    this.stmtListActionBefore = db.prepare(SQL_LIST_AUDIT_EVENTS_ACTION_BEFORE);
    this.stmtListWorkflow = db.prepare(SQL_LIST_AUDIT_EVENTS_WORKFLOW);
    this.stmtListWorkflowBefore = db.prepare(SQL_LIST_AUDIT_EVENTS_WORKFLOW_BEFORE);
  }

  insert(event: AuditEvent): void {
    this.stmtInsert.run(
      event.id,
      event.timestamp,
      event.actor,
      event.action,
      event.workflowId ?? null,
      event.taskId ?? null,
      event.targetKind ?? null,
      event.targetId ?? null,
      event.detail !== undefined ? JSON.stringify(event.detail) : null,
    );
  }

  list(opts: AuditListOpts = {}): AuditEvent[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    if (opts.workflowId !== undefined) {
      const wfOpts: { limit?: number; beforeTs?: string } = { limit };
      if (opts.beforeTs !== undefined) wfOpts.beforeTs = opts.beforeTs;
      return this.listByWorkflow(opts.workflowId, wfOpts);
    }
    if (opts.action !== undefined) {
      const rows = opts.beforeTs !== undefined
        ? this.stmtListActionBefore.all(opts.action, opts.beforeTs, limit)
        : this.stmtListAction.all(opts.action, limit);
      return rows.map(rowToEvent);
    }
    const rows = opts.beforeTs !== undefined
      ? this.stmtListBefore.all(opts.beforeTs, limit)
      : this.stmtList.all(limit);
    return rows.map(rowToEvent);
  }

  listByWorkflow(workflowId: string, opts: { limit?: number; beforeTs?: string } = {}): AuditEvent[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const beforeTs = opts.beforeTs;
    const rows = beforeTs !== undefined
      ? this.stmtListWorkflowBefore.all(workflowId, beforeTs, limit)
      : this.stmtListWorkflow.all(workflowId, limit);
    return rows.map(rowToEvent);
  }
}
