import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import Database from "better-sqlite3";
import { EventBus } from "../bus/eventBus.js";
import { SessionRegistry } from "./registry.js";
import { createLogger } from "../logger.js";
import { migrations } from "../store/migrations.js";
import { EngineError } from "../errors.js";
import type { EngineContext } from "../context.js";

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) {
    db.exec(m.sql);
  }
  return db;
}

function insertSession(db: Database.Database, slug: string, status: string): void {
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, created_at, updated_at, pr_draft, metadata
    ) VALUES (
      ?, ?, ?, 'task', ?, '[]', '[]',
      0, 0, 0, 0, 0, 0, 0, 0, 'mock',
      datetime('now'), datetime('now'), 0, '{}'
    )
  `).run(slug, "Test", "test prompt", status);
}

function readQueuePayloads(db: Database.Database, slug: string): string[] {
  const rows = db
    .prepare(
      `SELECT payload FROM reply_queue WHERE session_slug = ? AND delivered_at IS NULL ORDER BY queued_at ASC`,
    )
    .all(slug) as Array<{ payload: string }>;
  return rows.map((r) => r.payload);
}

describe("SessionRegistry.reply with attachments", () => {
  let workspaceDir: string;
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let auditActions: string[];

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "minions-reply-att-"));
    db = makeInMemoryDb();
    bus = new EventBus();
    auditActions = [];

    const ctx = {
      audit: {
        record: (_actor: string, action: string) => {
          auditActions.push(action);
        },
      },
    } as unknown as EngineContext;

    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx,
    });
  });

  afterEach(async () => {
    db.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  test("copies file from global uploads to session uploads dir, queues attached marker, persists attachments", async () => {
    const slug = "sess-aa";
    insertSession(db, slug, "running");

    const globalUploads = path.join(workspaceDir, "uploads");
    await fs.mkdir(globalUploads, { recursive: true });
    const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(path.join(globalUploads, "abc.png"), fileBytes);

    await registry.reply(slug, "hi", [
      { name: "a.png", mimeType: "image/png", url: "/api/uploads/abc.png" },
    ]);

    const sessionUploadPath = path.join(workspaceDir, "uploads", slug, "a.png");
    const copied = await fs.readFile(sessionUploadPath);
    assert.deepEqual(copied, fileBytes);

    assert.deepEqual(readQueuePayloads(db, slug), ["hi\n\n[Attached: a.png]\n"]);
    assert.ok(auditActions.includes("session.reply.queued"));

    const row = db
      .prepare(`SELECT body FROM transcript_events WHERE session_slug = ? ORDER BY seq ASC`)
      .get(slug) as { body: string } | undefined;
    assert.ok(row);
    const body = JSON.parse(row.body) as Record<string, unknown>;
    assert.equal(body["text"], "hi");
    assert.equal(body["source"], "operator");
    assert.deepEqual(body["attachments"], [
      { name: "a.png", mimeType: "image/png", url: "/api/uploads/abc.png" },
    ]);
  });

  test("rejects attachment with non-/api/uploads url", async () => {
    const slug = "sess-bad";
    insertSession(db, slug, "running");

    await assert.rejects(
      () =>
        registry.reply(slug, "hi", [
          { name: "x.png", mimeType: "image/png", url: "https://evil.example.com/x.png" },
        ]),
      (err: unknown) => err instanceof EngineError && (err as EngineError).code === "bad_request",
    );

    const count = (db
      .prepare(`SELECT COUNT(*) AS c FROM transcript_events WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(count, 0);
  });

  test("text-only reply enqueues plain payload (no attachments key)", async () => {
    const slug = "sess-plain";
    insertSession(db, slug, "running");

    await registry.reply(slug, "hello");

    assert.deepEqual(readQueuePayloads(db, slug), ["hello"]);

    const row = db
      .prepare(`SELECT body FROM transcript_events WHERE session_slug = ? ORDER BY seq ASC`)
      .get(slug) as { body: string } | undefined;
    assert.ok(row);
    const body = JSON.parse(row.body) as Record<string, unknown>;
    assert.equal(body["text"], "hello");
    assert.equal(body["source"], "operator");
    assert.equal(body["attachments"], undefined);
  });
});
