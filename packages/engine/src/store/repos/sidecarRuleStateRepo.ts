import type Database from "better-sqlite3";
import type { SidecarRuleState } from "@minions/shared";
import { nowIso } from "../../util/time.js";

interface SidecarRuleStateRow {
  rule_id: string;
  target_kind: string;
  target_id: string;
  last_action: string | null;
  attempts: number;
  cooldown_expires_at: string | null;
  last_input_hash: string | null;
  last_observed_at: string;
  updated_at: string;
}

function rowToState(row: SidecarRuleStateRow): SidecarRuleState {
  return {
    ruleId: row.rule_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    lastAction: row.last_action ?? undefined,
    attempts: row.attempts,
    cooldownExpiresAt: row.cooldown_expires_at ?? undefined,
    lastInputHash: row.last_input_hash ?? undefined,
    lastObservedAt: row.last_observed_at,
    updatedAt: row.updated_at,
  };
}

export interface TouchObservedResult {
  changed: boolean;
  attempts: number;
}

export class SidecarRuleStateRepo {
  private readonly selectByKey: Database.Statement;
  private readonly upsertState: Database.Statement;
  private readonly insertObserved: Database.Statement;
  private readonly updateObservedHash: Database.Statement;
  private readonly updateObservedTime: Database.Statement;
  private readonly upsertAction: Database.Statement;
  private readonly deleteExpiredCooldowns: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectByKey = db.prepare(
      `SELECT * FROM sidecar_rule_state
       WHERE rule_id = ? AND target_kind = ? AND target_id = ?`
    );
    this.upsertState = db.prepare(
      `INSERT INTO sidecar_rule_state(
        rule_id, target_kind, target_id, last_action, attempts,
        cooldown_expires_at, last_input_hash, last_observed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rule_id, target_kind, target_id) DO UPDATE SET
        last_action = excluded.last_action,
        attempts = excluded.attempts,
        cooldown_expires_at = excluded.cooldown_expires_at,
        last_input_hash = excluded.last_input_hash,
        last_observed_at = excluded.last_observed_at,
        updated_at = excluded.updated_at`
    );
    this.insertObserved = db.prepare(
      `INSERT INTO sidecar_rule_state(
        rule_id, target_kind, target_id, last_action, attempts,
        cooldown_expires_at, last_input_hash, last_observed_at, updated_at
      ) VALUES (?, ?, ?, NULL, 0, NULL, ?, ?, ?)`
    );
    this.updateObservedHash = db.prepare(
      `UPDATE sidecar_rule_state
       SET last_input_hash = ?, cooldown_expires_at = NULL,
           last_observed_at = ?, updated_at = ?
       WHERE rule_id = ? AND target_kind = ? AND target_id = ?`
    );
    this.updateObservedTime = db.prepare(
      `UPDATE sidecar_rule_state
       SET last_observed_at = ?, updated_at = ?
       WHERE rule_id = ? AND target_kind = ? AND target_id = ?`
    );
    this.upsertAction = db.prepare(
      `INSERT INTO sidecar_rule_state(
        rule_id, target_kind, target_id, last_action, attempts,
        cooldown_expires_at, last_input_hash, last_observed_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?)
      ON CONFLICT(rule_id, target_kind, target_id) DO UPDATE SET
        last_action = excluded.last_action,
        attempts = sidecar_rule_state.attempts + 1,
        cooldown_expires_at = excluded.cooldown_expires_at,
        updated_at = excluded.updated_at`
    );
    this.deleteExpiredCooldowns = db.prepare(
      `DELETE FROM sidecar_rule_state
       WHERE cooldown_expires_at IS NOT NULL AND cooldown_expires_at <= ?`
    );
  }

  get(ruleId: string, targetKind: string, targetId: string): SidecarRuleState | null {
    const row = this.selectByKey.get(ruleId, targetKind, targetId) as
      | SidecarRuleStateRow
      | undefined;
    return row ? rowToState(row) : null;
  }

  set(state: SidecarRuleState): void {
    this.upsertState.run(
      state.ruleId,
      state.targetKind,
      state.targetId,
      state.lastAction ?? null,
      state.attempts,
      state.cooldownExpiresAt ?? null,
      state.lastInputHash ?? null,
      state.lastObservedAt,
      state.updatedAt,
    );
  }

  touchObserved(
    ruleId: string,
    targetKind: string,
    targetId: string,
    inputHash: string,
  ): TouchObservedResult {
    const apply = this.db.transaction((): TouchObservedResult => {
      const now = nowIso();
      const existing = this.selectByKey.get(ruleId, targetKind, targetId) as
        | SidecarRuleStateRow
        | undefined;

      if (!existing) {
        this.insertObserved.run(ruleId, targetKind, targetId, inputHash, now, now);
        return { changed: true, attempts: 0 };
      }

      const hashDiffers = existing.last_input_hash !== inputHash;
      const cooldownExpired =
        existing.cooldown_expires_at !== null && existing.cooldown_expires_at <= now;

      if (hashDiffers || cooldownExpired) {
        this.updateObservedHash.run(inputHash, now, now, ruleId, targetKind, targetId);
        return { changed: true, attempts: existing.attempts };
      }

      this.updateObservedTime.run(now, now, ruleId, targetKind, targetId);
      return { changed: false, attempts: existing.attempts };
    });
    return apply();
  }

  recordAction(
    ruleId: string,
    targetKind: string,
    targetId: string,
    action: string,
    cooldownMs: number,
  ): void {
    const now = nowIso();
    const cooldownExpiresAt =
      cooldownMs > 0
        ? new Date(new Date(now).getTime() + cooldownMs).toISOString()
        : null;
    this.upsertAction.run(
      ruleId,
      targetKind,
      targetId,
      action,
      cooldownExpiresAt,
      now,
      now,
    );
  }

  clearExpiredCooldowns(now: string): number {
    const result = this.deleteExpiredCooldowns.run(now);
    return result.changes;
  }
}
