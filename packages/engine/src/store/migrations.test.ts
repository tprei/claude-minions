import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { openStore } from "./sqlite.js";
import { createLogger } from "../logger.js";

interface SessionsColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

describe("cost_budget_usd migration", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-cost-budget-mig-"));
  const dbPath = path.join(tmpDir, "test.db");
  const log = createLogger("error");

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies cost_budget_usd column to fresh DB", () => {
    const db = openStore({ path: dbPath, log });
    try {
      const cols = db
        .prepare(`PRAGMA table_info(sessions)`)
        .all() as SessionsColumnInfo[];
      const col = cols.find((c) => c.name === "cost_budget_usd");
      assert.ok(col, "sessions.cost_budget_usd column must exist");
      assert.equal(col!.type, "REAL");
      assert.equal(col!.notnull, 0, "cost_budget_usd must be nullable");
      assert.equal(col!.pk, 0);

      const applied = db
        .prepare(`SELECT name FROM schema_migrations`)
        .all() as { name: string }[];
      assert.ok(
        applied.some((r) => r.name === "005_session_cost_budget"),
        "005_session_cost_budget must be recorded as applied",
      );
    } finally {
      db.close();
    }
  });

  it("migration is idempotent on re-open", () => {
    const db = openStore({ path: dbPath, log });
    try {
      const applied = db
        .prepare(`SELECT name FROM schema_migrations WHERE name = ?`)
        .all("005_session_cost_budget") as { name: string }[];
      assert.equal(
        applied.length,
        1,
        "005_session_cost_budget must be recorded exactly once after re-open",
      );

      const cols = db
        .prepare(`PRAGMA table_info(sessions)`)
        .all() as SessionsColumnInfo[];
      const matches = cols.filter((c) => c.name === "cost_budget_usd");
      assert.equal(matches.length, 1, "cost_budget_usd must exist exactly once");
    } finally {
      db.close();
    }
  });
});
