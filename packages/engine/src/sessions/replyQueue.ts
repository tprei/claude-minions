import type Database from "better-sqlite3";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";

interface ReplyQueueRow {
  id: string;
  session_slug: string;
  payload: string;
  queued_at: string;
  delivered_at: string | null;
}

export class ReplyQueue {
  private readonly insertStmt: Database.Statement;
  private readonly drainStmt: Database.Statement;
  private readonly markDeliveredStmt: Database.Statement;
  private readonly pendingForSlugStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO reply_queue(id, session_slug, payload, queued_at, delivered_at)
       VALUES (?, ?, ?, ?, NULL)`,
    );
    this.drainStmt = db.prepare(
      `SELECT * FROM reply_queue
       WHERE session_slug = ? AND delivered_at IS NULL
       ORDER BY queued_at ASC
       LIMIT 1`,
    );
    this.markDeliveredStmt = db.prepare(
      `UPDATE reply_queue SET delivered_at = ? WHERE id = ?`,
    );
    this.pendingForSlugStmt = db.prepare(
      `SELECT * FROM reply_queue
       WHERE session_slug = ? AND delivered_at IS NULL
       ORDER BY queued_at ASC`,
    );
  }

  enqueue(slug: string, payload: string): string {
    const id = newId();
    this.insertStmt.run(id, slug, payload, nowIso());
    return id;
  }

  drain(slug: string): ReplyQueueRow | null {
    const row = this.drainStmt.get(slug) as ReplyQueueRow | undefined;
    return row ?? null;
  }

  markDelivered(id: string): void {
    this.markDeliveredStmt.run(nowIso(), id);
  }

  pendingAll(slug: string): ReplyQueueRow[] {
    return this.pendingForSlugStmt.all(slug) as ReplyQueueRow[];
  }
}
