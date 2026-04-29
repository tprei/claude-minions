import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import Database from "better-sqlite3";
import { EventBus } from "../../bus/eventBus.js";
import { SessionRegistry } from "../registry.js";
import { createLogger } from "../../logger.js";
import { migrations } from "../../store/migrations.js";
import { EngineError } from "../../errors.js";
import { MAX_ATTACHMENT_BYTES } from "../attachmentValidator.js";
import type { EngineContext } from "../../context.js";

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

function isBadRequest(err: unknown): boolean {
  return err instanceof EngineError && (err as EngineError).code === "bad_request";
}

describe("SessionRegistry.reply attachment safety", () => {
  let workspaceDir: string;
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "minions-att-safety-"));
    db = makeInMemoryDb();
    bus = new EventBus();

    const ctx = {
      audit: { record: () => {} },
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

  test("rejects attachment whose name traverses with ../", async () => {
    const slug = "sess-traverse";
    insertSession(db, slug, "running");

    const globalUploads = path.join(workspaceDir, "uploads");
    await fs.mkdir(globalUploads, { recursive: true });
    await fs.writeFile(path.join(globalUploads, "abc.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await assert.rejects(
      () =>
        registry.reply(slug, "hi", [
          { name: "../../etc/passwd", mimeType: "image/png", url: "/api/uploads/abc.png" },
        ]),
      isBadRequest,
    );

    const count = (db
      .prepare(`SELECT COUNT(*) AS c FROM transcript_events WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(count, 0);

    const escapeTarget = path.join(workspaceDir, "uploads", "etc", "passwd");
    await assert.rejects(() => fs.access(escapeTarget));
  });

  test("rejects attachment whose name is an absolute path", async () => {
    const slug = "sess-abs";
    insertSession(db, slug, "running");

    await assert.rejects(
      () =>
        registry.reply(slug, "hi", [
          {
            name: "/etc/passwd",
            mimeType: "image/png",
            dataBase64: Buffer.from([0x89, 0x50]).toString("base64"),
          },
        ]),
      isBadRequest,
    );
  });

  test("rejects attachment whose name contains a null byte", async () => {
    const slug = "sess-nul";
    insertSession(db, slug, "running");

    await assert.rejects(
      () =>
        registry.reply(slug, "hi", [
          {
            name: "ok.png\0.exe",
            mimeType: "image/png",
            dataBase64: Buffer.from([0x89, 0x50]).toString("base64"),
          },
        ]),
      isBadRequest,
    );
  });

  test("rejects oversized dataBase64 attachment", async () => {
    const slug = "sess-big";
    insertSession(db, slug, "running");

    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0).toString("base64");

    await assert.rejects(
      () =>
        registry.reply(slug, "hi", [
          { name: "big.png", mimeType: "image/png", dataBase64: oversized },
        ]),
      isBadRequest,
    );

    const written = await fs.readdir(path.join(workspaceDir, "uploads", slug)).catch(() => []);
    assert.deepEqual(written, []);
  });

  test("rejects attachment with disallowed mime type", async () => {
    const slug = "sess-mime";
    insertSession(db, slug, "running");

    const globalUploads = path.join(workspaceDir, "uploads");
    await fs.mkdir(globalUploads, { recursive: true });
    await fs.writeFile(path.join(globalUploads, "abc.png"), Buffer.from([0x89, 0x50]));

    await assert.rejects(
      () =>
        registry.reply(slug, "hi", [
          { name: "evil.svg", mimeType: "image/svg+xml", url: "/api/uploads/abc.png" },
        ]),
      isBadRequest,
    );
  });

  test("rejects attachment that supplies neither url nor dataBase64", async () => {
    const slug = "sess-empty";
    insertSession(db, slug, "running");

    await assert.rejects(
      () => registry.reply(slug, "hi", [{ name: "x.png", mimeType: "image/png" }]),
      isBadRequest,
    );
  });

  test("accepts valid url-based attachment", async () => {
    const slug = "sess-ok-url";
    insertSession(db, slug, "running");

    const globalUploads = path.join(workspaceDir, "uploads");
    await fs.mkdir(globalUploads, { recursive: true });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(path.join(globalUploads, "abc.png"), bytes);

    await registry.reply(slug, "hi", [
      { name: "good.png", mimeType: "image/png", url: "/api/uploads/abc.png" },
    ]);

    const copied = await fs.readFile(path.join(workspaceDir, "uploads", slug, "good.png"));
    assert.deepEqual(copied, bytes);
  });

  test("accepts valid dataBase64 attachment within size limit", async () => {
    const slug = "sess-ok-b64";
    insertSession(db, slug, "running");

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    await registry.reply(slug, "hi", [
      { name: "good.png", mimeType: "image/png", dataBase64: bytes.toString("base64") },
    ]);

    const written = await fs.readFile(path.join(workspaceDir, "uploads", slug, "good.png"));
    assert.deepEqual(written, bytes);
  });
});
