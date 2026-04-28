import type Database from "better-sqlite3";
import type { Memory, MemoryKind, MemoryStatus } from "@minions/shared";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";

interface MemoryRow {
  id: string;
  kind: string;
  status: string;
  scope: string;
  repo_id: string | null;
  pinned: number;
  title: string;
  body: string;
  proposed_by: string | null;
  proposed_from_session: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  supersedes: string | null;
  created_at: string;
  updated_at: string;
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    status: row.status as MemoryStatus,
    scope: row.scope as "global" | "repo",
    repoId: row.repo_id ?? undefined,
    pinned: row.pinned === 1,
    title: row.title,
    body: row.body,
    proposedBy: row.proposed_by ?? undefined,
    proposedFromSession: row.proposed_from_session ?? undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
    supersedes: row.supersedes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface MemoryFilter {
  status?: MemoryStatus;
  kind?: MemoryKind;
  scope?: "global" | "repo";
  repoId?: string;
  q?: string;
}

export class MemoryStore {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtGetById: Database.Statement;
  private readonly stmtUpdate: Database.Statement;
  private readonly stmtDelete: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(
      `INSERT INTO memories
         (id, kind, status, scope, repo_id, pinned, title, body,
          proposed_by, proposed_from_session, reviewed_by, reviewed_at,
          rejection_reason, supersedes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.stmtGetById = db.prepare(
      `SELECT * FROM memories WHERE id = ?`
    );

    this.stmtUpdate = db.prepare(
      `UPDATE memories SET
         kind = ?, status = ?, scope = ?, repo_id = ?, pinned = ?,
         title = ?, body = ?, proposed_by = ?, proposed_from_session = ?,
         reviewed_by = ?, reviewed_at = ?, rejection_reason = ?,
         supersedes = ?, updated_at = ?
       WHERE id = ?`
    );

    this.stmtDelete = db.prepare(`DELETE FROM memories WHERE id = ?`);
  }

  list(filter?: MemoryFilter): Memory[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.status !== undefined) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.kind !== undefined) {
      conditions.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter?.scope !== undefined) {
      conditions.push("scope = ?");
      params.push(filter.scope);
    }
    if (filter?.repoId !== undefined) {
      conditions.push("repo_id = ?");
      params.push(filter.repoId);
    }
    if (filter?.q !== undefined && filter.q !== "") {
      conditions.push("(LOWER(title) LIKE ? OR LOWER(body) LIKE ?)");
      const needle = `%${filter.q.toLowerCase()}%`;
      params.push(needle, needle);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM memories ${where} ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  getById(id: string): Memory | null {
    const row = this.stmtGetById.get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  insert(data: Omit<Memory, "id" | "createdAt" | "updatedAt">): Memory {
    const id = newId();
    const now = nowIso();
    this.stmtInsert.run(
      id,
      data.kind,
      data.status,
      data.scope,
      data.repoId ?? null,
      data.pinned ? 1 : 0,
      data.title,
      data.body,
      data.proposedBy ?? null,
      data.proposedFromSession ?? null,
      data.reviewedBy ?? null,
      data.reviewedAt ?? null,
      data.rejectionReason ?? null,
      data.supersedes ?? null,
      now,
      now
    );
    return this.getById(id)!;
  }

  save(memory: Memory): Memory {
    this.stmtUpdate.run(
      memory.kind,
      memory.status,
      memory.scope,
      memory.repoId ?? null,
      memory.pinned ? 1 : 0,
      memory.title,
      memory.body,
      memory.proposedBy ?? null,
      memory.proposedFromSession ?? null,
      memory.reviewedBy ?? null,
      memory.reviewedAt ?? null,
      memory.rejectionReason ?? null,
      memory.supersedes ?? null,
      nowIso(),
      memory.id
    );
    return this.getById(memory.id)!;
  }

  remove(id: string): void {
    this.stmtDelete.run(id);
  }
}
