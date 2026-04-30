import type Database from "better-sqlite3";
import type { LifecycleEvent, LifecycleEventType, LifecycleSeverity } from "@minions/shared";
import { newId } from "../../util/ids.js";
import { nowIso } from "../../util/time.js";

interface LifecycleRow {
  id: string;
  timestamp: string;
  event_type: string;
  severity: string;
  message: string;
  detail: string | null;
}

function rowToEvent(row: LifecycleRow): LifecycleEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    eventType: row.event_type as LifecycleEventType,
    severity: row.severity as LifecycleSeverity,
    message: row.message,
    detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : undefined,
  };
}

export class LifecycleRepo {
  private readonly insert: Database.Statement;
  private readonly selectRecent: Database.Statement;
  private readonly selectBefore: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insert = db.prepare(
      `INSERT INTO engine_lifecycle_events(id, timestamp, event_type, severity, message, detail)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.selectRecent = db.prepare(
      `SELECT * FROM engine_lifecycle_events ORDER BY timestamp DESC LIMIT ?`
    );
    this.selectBefore = db.prepare(
      `SELECT * FROM engine_lifecycle_events WHERE timestamp < ? ORDER BY timestamp DESC LIMIT ?`
    );
  }

  record(
    eventType: LifecycleEventType,
    severity: LifecycleSeverity,
    message: string,
    detail?: Record<string, unknown>,
  ): void {
    this.insert.run(
      newId(),
      nowIso(),
      eventType,
      severity,
      message,
      detail ? JSON.stringify(detail) : null,
    );
  }

  list(limit: number, beforeTs?: string): LifecycleEvent[] {
    const rows = (
      beforeTs
        ? (this.selectBefore.all(beforeTs, limit) as LifecycleRow[])
        : (this.selectRecent.all(limit) as LifecycleRow[])
    );
    return rows.map(rowToEvent);
  }
}
