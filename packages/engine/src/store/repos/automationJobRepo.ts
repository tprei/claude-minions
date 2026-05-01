import type Database from "better-sqlite3";
import type { AutomationJob, AutomationJobStatus } from "@minions/shared";
import { newId } from "../../util/ids.js";
import { nowIso } from "../../util/time.js";

interface AutomationJobRow {
  id: string;
  kind: string;
  target_kind: string | null;
  target_id: string | null;
  payload_json: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: AutomationJobRow): AutomationJob {
  return {
    id: row.id,
    kind: row.kind,
    targetKind: row.target_kind ?? undefined,
    targetId: row.target_id ?? undefined,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status as AutomationJobStatus,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRunAt: row.next_run_at,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface EnqueueInput {
  kind: string;
  targetKind?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  runAt?: string;
}

export class AutomationJobRepo {
  private readonly insert: Database.Statement;
  private readonly selectById: Database.Statement;
  private readonly selectNextDue: Database.Statement;
  private readonly claimById: Database.Statement;
  private readonly markSucceeded: Database.Statement;
  private readonly markFailed: Database.Statement;
  private readonly markRetry: Database.Statement;
  private readonly selectByTarget: Database.Statement;
  private readonly selectExpiredLeases: Database.Statement;
  private readonly releaseLease: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insert = db.prepare(
      `INSERT INTO automation_jobs(
        id, kind, target_kind, target_id, payload_json, status,
        attempts, max_attempts, next_run_at, lease_owner, lease_expires_at,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, NULL, ?, ?)`
    );
    this.selectById = db.prepare(`SELECT * FROM automation_jobs WHERE id = ?`);
    this.selectNextDue = db.prepare(
      `SELECT id FROM automation_jobs
       WHERE status = 'pending' AND next_run_at <= ?
       ORDER BY next_run_at ASC, id ASC
       LIMIT 1`
    );
    this.claimById = db.prepare(
      `UPDATE automation_jobs
       SET status = 'running', lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    );
    this.markSucceeded = db.prepare(
      `UPDATE automation_jobs
       SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`
    );
    this.markFailed = db.prepare(
      `UPDATE automation_jobs
       SET status = 'failed', attempts = ?, last_error = ?,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`
    );
    this.markRetry = db.prepare(
      `UPDATE automation_jobs
       SET status = 'pending', attempts = ?, last_error = ?, next_run_at = ?,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`
    );
    this.selectByTarget = db.prepare(
      `SELECT * FROM automation_jobs
       WHERE target_kind = ? AND target_id = ?
       ORDER BY created_at ASC`
    );
    this.selectExpiredLeases = db.prepare(
      `SELECT id FROM automation_jobs
       WHERE lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`
    );
    this.releaseLease = db.prepare(
      `UPDATE automation_jobs
       SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`
    );
  }

  enqueue(input: EnqueueInput): AutomationJob {
    const id = newId();
    const now = nowIso();
    const payload = JSON.stringify(input.payload ?? {});
    const maxAttempts = input.maxAttempts ?? 5;
    const runAt = input.runAt ?? now;
    this.insert.run(
      id,
      input.kind,
      input.targetKind ?? null,
      input.targetId ?? null,
      payload,
      maxAttempts,
      runAt,
      now,
      now,
    );
    const row = this.selectById.get(id) as AutomationJobRow;
    return rowToJob(row);
  }

  claimNextDue(now: string, leaseOwner: string, leaseDurationMs: number): AutomationJob | null {
    const leaseExpiresAt = new Date(new Date(now).getTime() + leaseDurationMs).toISOString();
    const claim = this.db.transaction((): AutomationJob | null => {
      const candidate = this.selectNextDue.get(now) as { id: string } | undefined;
      if (!candidate) return null;
      const result = this.claimById.run(leaseOwner, leaseExpiresAt, now, candidate.id);
      if (result.changes !== 1) return null;
      const row = this.selectById.get(candidate.id) as AutomationJobRow;
      return rowToJob(row);
    });
    return claim();
  }

  succeed(id: string): void {
    this.markSucceeded.run(nowIso(), id);
  }

  fail(id: string, error: string, retryDelayMs = 0): void {
    const now = nowIso();
    const apply = this.db.transaction(() => {
      const row = this.selectById.get(id) as AutomationJobRow | undefined;
      if (!row) return;
      const attempts = row.attempts + 1;
      if (attempts >= row.max_attempts) {
        this.markFailed.run(attempts, error, now, id);
      } else {
        const nextRunAt = new Date(new Date(now).getTime() + Math.max(0, retryDelayMs)).toISOString();
        this.markRetry.run(attempts, error, nextRunAt, now, id);
      }
    });
    apply();
  }

  releaseExpiredLeases(now: string): number {
    const release = this.db.transaction((): number => {
      const rows = this.selectExpiredLeases.all(now) as { id: string }[];
      for (const r of rows) {
        this.releaseLease.run(now, r.id);
      }
      return rows.length;
    });
    return release();
  }

  findByTarget(targetKind: string, targetId: string): AutomationJob[] {
    const rows = this.selectByTarget.all(targetKind, targetId) as AutomationJobRow[];
    return rows.map(rowToJob);
  }

  get(id: string): AutomationJob | null {
    const row = this.selectById.get(id) as AutomationJobRow | undefined;
    return row ? rowToJob(row) : null;
  }
}
