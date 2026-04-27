import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { openStore } from "./sqlite.js";
import { createLogger } from "../logger.js";

const EXPECTED_TABLES = [
  "schema_migrations",
  "meta",
  "repos",
  "sessions",
  "transcript_events",
  "checkpoints",
  "dags",
  "dag_nodes",
  "memories",
  "audit_events",
  "external_tasks",
  "loops",
  "quality_reports",
  "merge_readiness",
  "push_subscriptions",
  "runtime_config",
  "entrypoints",
  "session_attachments",
  "screenshots",
  "reply_queue",
  "session_feedback",
  "ship_state",
  "provider_state",
];

describe("openStore", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  const log = createLogger("error");
  const db = openStore({ path: dbPath, log });

  after(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a database file", () => {
    assert.ok(fs.existsSync(dbPath));
  });

  it("applies all migrations and creates expected tables", () => {
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      )
      .all() as { name: string }[];

    const actualTables = new Set(rows.map((r) => r.name));

    for (const table of EXPECTED_TABLES) {
      assert.ok(actualTables.has(table), `Missing table: ${table}`);
    }
  });

  it("records the migration as applied", () => {
    const applied = db
      .prepare(`SELECT name FROM schema_migrations`)
      .all() as { name: string }[];
    assert.ok(applied.length >= 1);
    assert.ok(applied.some((r) => r.name === "001_initial"));
  });

  it("running openStore again on same file is idempotent", () => {
    const db2 = openStore({ path: dbPath, log });
    const rows = db2
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[];
    assert.ok(rows.length >= EXPECTED_TABLES.length);
    db2.close();
  });
});
