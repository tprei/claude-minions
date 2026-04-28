import type Database from "better-sqlite3";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";

interface ReplyQueueRow {
  id: string;
  session_slug: string;
  payload: string;
  queued_at: string;
}

export interface ReplyQueueEntry {
  id: string;
  sessionSlug: string;
  payload: string;
  queuedAt: string;
}

export class ReplyQueue {
  private readonly insertStmt: Database.Statement;
  private readonly selectAllStmt: Database.Statement;
  private readonly deleteForSlugStmt: Database.Statement;
  private seqCounter = 0;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO reply_queue(id, session_slug, payload, queued_at, delivered_at)
       VALUES (?, ?, ?, ?, NULL)`,
    );
    this.selectAllStmt = db.prepare(
      `SELECT id, session_slug, payload, queued_at FROM reply_queue
       WHERE session_slug = ? AND delivered_at IS NULL
       ORDER BY queued_at ASC`,
    );
    this.deleteForSlugStmt = db.prepare(
      `DELETE FROM reply_queue WHERE session_slug = ? AND delivered_at IS NULL`,
    );
  }

  enqueue(slug: string, payload: string): string {
    const id = newId();
    this.seqCounter += 1;
    const queuedAt = `${nowIso()}#${String(this.seqCounter).padStart(12, "0")}`;
    this.insertStmt.run(id, slug, payload, queuedAt);
    return id;
  }

  drain(slug: string): ReplyQueueEntry[] {
    const drainTxn = this.db.transaction((s: string): ReplyQueueRow[] => {
      const rows = this.selectAllStmt.all(s) as ReplyQueueRow[];
      this.deleteForSlugStmt.run(s);
      return rows;
    });
    const rows = drainTxn(slug);
    return rows.map((r) => ({
      id: r.id,
      sessionSlug: r.session_slug,
      payload: r.payload,
      queuedAt: r.queued_at,
    }));
  }

  pending(slug: string): ReplyQueueEntry[] {
    const rows = this.selectAllStmt.all(slug) as ReplyQueueRow[];
    return rows.map((r) => ({
      id: r.id,
      sessionSlug: r.session_slug,
      payload: r.payload,
      queuedAt: r.queued_at,
    }));
  }
}
