import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import type { Alert, AlertSubscription } from "./alert.js";
import type { AlertKind, AlertSeverity } from "./alert.js";
import {
  AUDIT_SCHEMA_DDL,
  SQL_INSERT_ALERT,
  SQL_LIST_ALERTS,
  SQL_LIST_ALERTS_BEFORE,
  SQL_UPSERT_ALERT_SUBSCRIPTION,
  SQL_DELETE_ALERT_SUBSCRIPTION,
  SQL_LIST_ALERT_SUBSCRIPTIONS,
} from "../persistence/audit-schema.js";
import { configureSqliteDatabase } from "../persistence/sqlite-options.js";

interface AlertRow {
  id: string;
  timestamp: string;
  kind: string;
  severity: string;
  message: string;
  workflow_id: string | null;
  task_id: string | null;
  detail: string | null;
}

interface AlertSubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function parseStoredDetail(detail: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function rowToAlert(row: AlertRow): Alert {
  const alert: Alert = {
    id: row.id,
    timestamp: row.timestamp,
    kind: row.kind as AlertKind,
    severity: row.severity as AlertSeverity,
    message: row.message,
  };
  if (row.workflow_id !== null) alert.workflowId = row.workflow_id;
  if (row.task_id !== null) alert.taskId = row.task_id;
  if (row.detail !== null) {
    const detail = parseStoredDetail(row.detail);
    if (detail !== undefined) alert.detail = detail;
  }
  return alert;
}

export interface AlertListCursor {
  timestamp: string;
  id: string;
}

export interface AlertListOpts {
  limit?: number;
  before?: AlertListCursor;
}

export class AlertRepo {
  private readonly stmtInsert: Statement<[string, string, string, string, string, string | null, string | null, string | null]>;
  private readonly stmtList: Statement<[number], AlertRow>;
  private readonly stmtListBefore: Statement<[string, string, string, number], AlertRow>;

  constructor(db: Database.Database) {
    configureSqliteDatabase(db);
    db.exec(AUDIT_SCHEMA_DDL);
    this.stmtInsert = db.prepare(SQL_INSERT_ALERT);
    this.stmtList = db.prepare(SQL_LIST_ALERTS);
    this.stmtListBefore = db.prepare(SQL_LIST_ALERTS_BEFORE);
  }

  insert(alert: Alert): void {
    this.stmtInsert.run(
      alert.id,
      alert.timestamp,
      alert.kind,
      alert.severity,
      alert.message,
      alert.workflowId ?? null,
      alert.taskId ?? null,
      alert.detail !== undefined ? JSON.stringify(alert.detail) : null,
    );
  }

  list(opts: AlertListOpts = {}): Alert[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = opts.before !== undefined
      ? this.stmtListBefore.all(opts.before.timestamp, opts.before.timestamp, opts.before.id, limit)
      : this.stmtList.all(limit);
    return rows.map(rowToAlert);
  }
}

export class AlertSubscriptionRepo {
  private readonly stmtUpsert: Statement<[string, string, string, string]>;
  private readonly stmtDelete: Statement<[string]>;
  private readonly stmtList: Statement<[], AlertSubRow>;

  constructor(db: Database.Database) {
    configureSqliteDatabase(db);
    db.exec(AUDIT_SCHEMA_DDL);
    this.stmtUpsert = db.prepare(SQL_UPSERT_ALERT_SUBSCRIPTION);
    this.stmtDelete = db.prepare(SQL_DELETE_ALERT_SUBSCRIPTION);
    this.stmtList = db.prepare(SQL_LIST_ALERT_SUBSCRIPTIONS);
  }

  upsert(sub: AlertSubscription): void {
    this.stmtUpsert.run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString());
  }

  remove(endpoint: string): void {
    this.stmtDelete.run(endpoint);
  }

  list(): AlertSubscription[] {
    return this.stmtList.all().map((row) => ({
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    }));
  }
}
