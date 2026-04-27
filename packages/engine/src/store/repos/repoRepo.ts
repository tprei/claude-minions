import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { RepoBinding } from "@minions/shared";

interface RepoRow {
  id: string;
  label: string;
  remote: string | null;
  default_branch: string;
}

function rowToBinding(row: RepoRow): RepoBinding {
  return {
    id: row.id,
    label: row.label,
    remote: row.remote ?? undefined,
    defaultBranch: row.default_branch,
  };
}

export class RepoRepo {
  private readonly selectAll: Database.Statement;
  private readonly selectOne: Database.Statement;
  private readonly upsertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectAll = db.prepare(`SELECT * FROM repos ORDER BY id`);
    this.selectOne = db.prepare(`SELECT * FROM repos WHERE id = ?`);
    this.upsertStmt = db.prepare(
      `INSERT INTO repos(id, label, remote, default_branch)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         remote = excluded.remote,
         default_branch = excluded.default_branch`
    );
    this.deleteStmt = db.prepare(`DELETE FROM repos WHERE id = ?`);
  }

  list(): RepoBinding[] {
    return (this.selectAll.all() as RepoRow[]).map(rowToBinding);
  }

  get(id: string): RepoBinding | null {
    const row = this.selectOne.get(id) as RepoRow | undefined;
    return row ? rowToBinding(row) : null;
  }

  upsert(repo: RepoBinding): void {
    this.upsertStmt.run(
      repo.id,
      repo.label,
      repo.remote ?? null,
      repo.defaultBranch ?? "main"
    );
  }

  delete(id: string): void {
    this.deleteStmt.run(id);
  }

  loadFromEnv(raw: string | undefined): void {
    if (!raw) return;
    const entries = JSON.parse(raw) as { id: string; label: string; remote?: string; defaultBranch?: string }[];
    for (const entry of entries) {
      this.upsert({
        id: entry.id,
        label: entry.label,
        remote: entry.remote,
        defaultBranch: entry.defaultBranch ?? "main",
      });
    }
  }

  loadFromFile(jsonPath: string): boolean {
    let text: string;
    try {
      text = fs.readFileSync(jsonPath, "utf8");
    } catch {
      return false;
    }
    let entries: { id: string; label: string; remote?: string; defaultBranch?: string }[];
    try {
      entries = JSON.parse(text);
    } catch (err) {
      throw new Error(`failed to parse ${jsonPath}: ${(err as Error).message}`);
    }
    for (const entry of entries) {
      this.upsert({
        id: entry.id,
        label: entry.label,
        remote: entry.remote,
        defaultBranch: entry.defaultBranch ?? "main",
      });
    }
    return true;
  }

  static repoFilePath(workspaceDir: string): string {
    return path.join(workspaceDir, "repos.json");
  }
}
