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

export interface ReplyClaim {
  claimToken: string;
  entries: ReplyQueueEntry[];
}

export class ReplyQueue {
  private readonly insertStmt: Database.Statement;
  private readonly selectPendingStmt: Database.Statement;
  private readonly claimPendingStmt: Database.Statement;
  private readonly selectClaimedStmt: Database.Statement;
  private readonly deleteByClaimStmt: Database.Statement;
  private readonly releaseByClaimStmt: Database.Statement;
  private readonly releaseStaleStmt: Database.Statement;
  private seqCounter = 0;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO reply_queue(id, session_slug, payload, queued_at, delivered_at)
       VALUES (?, ?, ?, ?, NULL)`,
    );
    this.selectPendingStmt = db.prepare(
      `SELECT id, session_slug, payload, queued_at FROM reply_queue
       WHERE session_slug = ? AND delivered_at IS NULL AND claim_token IS NULL
       ORDER BY queued_at ASC`,
    );
    this.claimPendingStmt = db.prepare(
      `UPDATE reply_queue
         SET claim_token = ?, claimed_at = ?
       WHERE session_slug = ? AND delivered_at IS NULL AND claim_token IS NULL`,
    );
    this.selectClaimedStmt = db.prepare(
      `SELECT id, session_slug, payload, queued_at FROM reply_queue
       WHERE claim_token = ? AND delivered_at IS NULL
       ORDER BY queued_at ASC`,
    );
    this.deleteByClaimStmt = db.prepare(
      `DELETE FROM reply_queue WHERE claim_token = ? AND delivered_at IS NULL`,
    );
    this.releaseByClaimStmt = db.prepare(
      `UPDATE reply_queue
         SET claim_token = NULL, claimed_at = NULL
       WHERE claim_token = ? AND delivered_at IS NULL`,
    );
    this.releaseStaleStmt = db.prepare(
      `UPDATE reply_queue
         SET claim_token = NULL, claimed_at = NULL
       WHERE delivered_at IS NULL
         AND claim_token IS NOT NULL
         AND claimed_at IS NOT NULL
         AND claimed_at < ?`,
    );
  }

  enqueue(slug: string, payload: string): string {
    const id = newId();
    this.seqCounter += 1;
    const queuedAt = `${nowIso()}#${String(this.seqCounter).padStart(12, "0")}`;
    this.insertStmt.run(id, slug, payload, queuedAt);
    return id;
  }

  claim(slug: string): ReplyClaim | null {
    const claimToken = newId();
    const claimedAt = nowIso();

    const claimTxn = this.db.transaction((s: string, token: string, at: string): ReplyQueueRow[] => {
      const pending = this.selectPendingStmt.all(s) as ReplyQueueRow[];
      if (pending.length === 0) return [];
      this.claimPendingStmt.run(token, at, s);
      return this.selectClaimedStmt.all(token) as ReplyQueueRow[];
    });

    const rows = claimTxn(slug, claimToken, claimedAt);
    if (rows.length === 0) return null;

    return {
      claimToken,
      entries: rows.map((r) => ({
        id: r.id,
        sessionSlug: r.session_slug,
        payload: r.payload,
        queuedAt: r.queued_at,
      })),
    };
  }

  confirm(claimToken: string): void {
    this.deleteByClaimStmt.run(claimToken);
  }

  release(claimToken: string): void {
    this.releaseByClaimStmt.run(claimToken);
  }

  recoverInFlight(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.releaseStaleStmt.run(cutoff);
    return result.changes;
  }

  pending(slug: string): ReplyQueueEntry[] {
    const rows = this.selectPendingStmt.all(slug) as ReplyQueueRow[];
    return rows.map((r) => ({
      id: r.id,
      sessionSlug: r.session_slug,
      payload: r.payload,
      queuedAt: r.queued_at,
    }));
  }
}
