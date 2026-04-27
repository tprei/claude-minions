import { simpleGit } from "simple-git";
import type Database from "better-sqlite3";
import type { Checkpoint, CheckpointReason } from "@minions/shared";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { EngineError } from "../errors.js";

interface CheckpointRow {
  id: string;
  session_slug: string;
  reason: string;
  sha: string;
  branch: string;
  message: string;
  turn: number;
  created_at: string;
}

interface SessionWorktreeInfo {
  worktreePath: string;
  branch?: string;
}

function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    sessionSlug: row.session_slug,
    reason: row.reason as CheckpointReason,
    sha: row.sha,
    branch: row.branch,
    message: row.message,
    turn: row.turn,
    createdAt: row.created_at,
  };
}

export class Checkpoints {
  private readonly listStmt: Database.Statement;
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly getCurrentTurnStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.listStmt = db.prepare(
      `SELECT * FROM checkpoints WHERE session_slug = ? ORDER BY created_at DESC`,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO checkpoints(id, session_slug, reason, sha, branch, message, turn, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getStmt = db.prepare(`SELECT * FROM checkpoints WHERE id = ?`);
    this.getCurrentTurnStmt = db.prepare(
      `SELECT stats_turns, branch, worktree_path FROM sessions WHERE slug = ?`,
    );
  }

  list(slug: string): Checkpoint[] {
    return (this.listStmt.all(slug) as CheckpointRow[]).map(rowToCheckpoint);
  }

  async capture(
    slug: string,
    info: SessionWorktreeInfo,
    reason: CheckpointReason,
    message: string,
  ): Promise<Checkpoint> {
    const { worktreePath, branch } = info;
    if (!worktreePath) {
      throw new EngineError("bad_request", `Session ${slug} has no worktree`);
    }

    const git = simpleGit(worktreePath);
    await git.addConfig("user.email", "minions@localhost");
    await git.addConfig("user.name", "Minions");

    await git.raw(["commit", "--allow-empty", "-m", message]);
    const sha = (await git.revparse(["HEAD"])).trim();

    const row = this.getCurrentTurnStmt.get(slug) as { stats_turns: number; branch: string | null; worktree_path: string | null } | undefined;
    const turn = row?.stats_turns ?? 0;
    const resolvedBranch = branch ?? row?.branch ?? "unknown";

    const id = newId();
    const createdAt = nowIso();
    this.insertStmt.run(id, slug, reason, sha, resolvedBranch, message, turn, createdAt);

    return {
      id,
      sessionSlug: slug,
      reason,
      sha,
      branch: resolvedBranch,
      message,
      turn,
      createdAt,
    };
  }

  async restore(slug: string, id: string, info: SessionWorktreeInfo): Promise<void> {
    const row = this.getStmt.get(id) as CheckpointRow | undefined;
    if (!row || row.session_slug !== slug) {
      throw new EngineError("not_found", `Checkpoint ${id} not found for session ${slug}`);
    }

    const { worktreePath } = info;
    if (!worktreePath) {
      throw new EngineError("bad_request", `Session ${slug} has no worktree`);
    }

    const git = simpleGit(worktreePath);
    await git.raw(["reset", "--hard", row.sha]);
  }
}
