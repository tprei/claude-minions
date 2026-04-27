import type Database from "better-sqlite3";
import type { AuditEvent } from "@minions/shared";
import { newId } from "../../util/ids.js";
import { nowIso } from "../../util/time.js";

interface AuditRow {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  detail: string | null;
}

function rowToEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    actor: row.actor,
    action: row.action,
    target: row.target_kind && row.target_id ? { kind: row.target_kind, id: row.target_id } : undefined,
    detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : undefined,
  };
}

export class AuditRepo {
  private readonly insert: Database.Statement;
  private readonly selectRecent: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insert = db.prepare(
      `INSERT INTO audit_events(id, timestamp, actor, action, target_kind, target_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    this.selectRecent = db.prepare(
      `SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT ?`
    );
  }

  record(
    actor: string,
    action: string,
    target?: { kind: string; id: string },
    detail?: Record<string, unknown>
  ): void {
    this.insert.run(
      newId(),
      nowIso(),
      actor,
      action,
      target?.kind ?? null,
      target?.id ?? null,
      detail ? JSON.stringify(detail) : null
    );
  }

  list(limit = 100): AuditEvent[] {
    return (this.selectRecent.all(limit) as AuditRow[]).map(rowToEvent);
  }
}
