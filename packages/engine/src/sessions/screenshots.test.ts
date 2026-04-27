import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import Database from "better-sqlite3";
import { EventBus } from "../bus/eventBus.js";
import { migrations } from "../store/migrations.js";
import { isEngineError } from "../errors.js";
import { Screenshots } from "./screenshots.js";

const TRANSPARENT_PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) {
    db.exec(m.sql);
  }
  return db;
}

function insertSession(db: Database.Database, slug: string): void {
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, created_at, updated_at, pr_draft, metadata
    ) VALUES (
      ?, ?, ?, 'task', 'pending', '[]', '[]',
      0, 0, 0, 0, 0, 0, 0, 0, 'mock', datetime('now'), datetime('now'), 0, '{}'
    )
  `).run(slug, "test", "test prompt");
}

describe("Screenshots", () => {
  let db: Database.Database;
  let bus: EventBus;
  let tmpRoot: string;
  let screenshots: Screenshots;
  const slug = "session-abc";

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "screenshots-test-"));
    insertSession(db, slug);
    screenshots = new Screenshots({
      db,
      bus,
      screenshotsDir: (s) => path.join(tmpRoot, s, "screenshots"),
    });
  });

  afterEach(() => {
    db.close();
    fsSync.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("capture writes the file, inserts the row, and emits screenshot_captured", async () => {
    const events: Array<{ filename: string; sessionSlug: string }> = [];
    bus.on("session_screenshot_captured", (ev) => {
      events.push({ filename: ev.filename, sessionSlug: ev.sessionSlug });
    });

    const result = await screenshots.capture(slug, {
      source: "turn_end",
      pngBuffer: TRANSPARENT_PNG_1X1,
      description: "lifecycle",
    });

    assert.ok(result.filename.endsWith("-turn_end.png"));
    assert.equal(result.byteSize, TRANSPARENT_PNG_1X1.byteLength);
    assert.equal(result.url, `/api/sessions/${slug}/screenshots/${result.filename}`);

    const filePath = path.join(tmpRoot, slug, "screenshots", result.filename);
    const onDisk = await fs.readFile(filePath);
    assert.deepEqual(onDisk, TRANSPARENT_PNG_1X1);

    const row = db
      .prepare(`SELECT filename, byte_size, description FROM screenshots WHERE session_slug = ?`)
      .get(slug) as { filename: string; byte_size: number; description: string | null } | undefined;
    assert.ok(row);
    assert.equal(row.filename, result.filename);
    assert.equal(row.byte_size, TRANSPARENT_PNG_1X1.byteLength);
    assert.equal(row.description, "lifecycle");

    assert.equal(events.length, 1);
    assert.equal(events[0]?.filename, result.filename);
    assert.equal(events[0]?.sessionSlug, slug);
  });

  test("screenshotPath rejects '../etc/passwd'", () => {
    assert.throws(
      () => screenshots.screenshotPath(slug, "../etc/passwd"),
      (err: unknown) => isEngineError(err) && err.code === "bad_request",
    );
  });

  test("screenshotPath rejects 'subdir/file.png'", () => {
    assert.throws(
      () => screenshots.screenshotPath(slug, "subdir/file.png"),
      (err: unknown) => isEngineError(err) && err.code === "bad_request",
    );
  });

  test("screenshotPath accepts a normal filename", () => {
    const filename = "2026-04-27T12-00-00-000Z-turn_end.png";
    const resolved = screenshots.screenshotPath(slug, filename);
    assert.equal(resolved, path.join(tmpRoot, slug, "screenshots", filename));
  });

  test("list returns the inserted row's data with filename only (not absolute path)", async () => {
    const captured = await screenshots.capture(slug, {
      source: "readiness_change",
      pngBuffer: TRANSPARENT_PNG_1X1,
    });

    const items = screenshots.list(slug);
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.filename, captured.filename);
    assert.ok(!item.filename.includes("/"));
    assert.ok(!item.filename.includes("\\"));
    assert.ok(!path.isAbsolute(item.filename));
    assert.equal(item.url, `/api/sessions/${slug}/screenshots/${captured.filename}`);
    assert.equal(item.byteSize, TRANSPARENT_PNG_1X1.byteLength);
  });
});
