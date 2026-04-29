import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { SessionDeletedEvent } from "@minions/shared";
import { EventBus } from "../../bus/eventBus.js";
import { SessionRegistry } from "../registry.js";
import { createLogger } from "../../logger.js";
import { migrations } from "../../store/migrations.js";
import type { EngineContext } from "../../context.js";
import type { ProviderHandle, ProviderEvent } from "../../providers/provider.js";

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function insertSession(db: Database.Database, slug: string, status = "running"): void {
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, created_at, updated_at, pr_draft, metadata
    ) VALUES (
      ?, ?, ?, 'task', ?, '[]', '[]',
      0, 0, 0, 0, 0, 0, 0, 0, 'mock', datetime('now'), datetime('now'), 0, '{}'
    )
  `).run(slug, "test", "prompt", status);
}

function insertTranscriptEvent(db: Database.Database, slug: string, seq: number): void {
  db.prepare(
    `INSERT INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
     VALUES (?, ?, ?, 0, 'user_message', ?, datetime('now'))`,
  ).run(`ev-${slug}-${seq}`, slug, seq, JSON.stringify({ text: "hi", source: "operator" }));
}

function insertReplyQueueRow(db: Database.Database, slug: string, payload: string): void {
  db.prepare(
    `INSERT INTO reply_queue(id, session_slug, payload, queued_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).run(`rq-${slug}-${payload}`, slug, payload);
}

function insertScreenshot(db: Database.Database, slug: string, filename: string): void {
  db.prepare(
    `INSERT INTO screenshots(id, session_slug, filename, byte_size, captured_at)
     VALUES (?, ?, ?, 0, datetime('now'))`,
  ).run(`sc-${slug}-${filename}`, slug, filename);
}

function insertCheckpoint(db: Database.Database, slug: string, id: string): void {
  db.prepare(
    `INSERT INTO checkpoints(id, session_slug, reason, sha, branch, message, turn, created_at)
     VALUES (?, ?, 'manual', 'sha', 'br', 'msg', 0, datetime('now'))`,
  ).run(id, slug);
}

function insertProviderState(db: Database.Database, slug: string): void {
  db.prepare(
    `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
     VALUES (?, 'mock', 'ext-id', 0, 0, '{}', datetime('now'))`,
  ).run(slug);
}

function makeStubCtx(): EngineContext {
  return {
    audit: {
      record: () => {},
      list: () => [],
    },
    dags: {
      onSessionTerminal: async () => {},
    },
    ship: {
      onTurnCompleted: async () => {},
    },
    env: {
      host: "127.0.0.1",
      port: 8787,
      token: "test-token",
    },
    memory: {
      renderPreamble: () => "",
    },
  } as unknown as EngineContext;
}

function injectHandle(registry: SessionRegistry, slug: string, handle: ProviderHandle): void {
  (registry as unknown as { handles: Map<string, ProviderHandle> }).handles.set(slug, handle);
}

describe("SessionRegistry.delete", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "delete-test-"));
    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(),
    });
  });

  afterEach(() => {
    db.close();
  });

  test("removes the session row and all related rows for the slug", async () => {
    const slug = "sess-target";
    const other = "sess-other";

    insertSession(db, slug);
    insertSession(db, other);

    insertTranscriptEvent(db, slug, 0);
    insertTranscriptEvent(db, slug, 1);
    insertTranscriptEvent(db, other, 0);

    insertReplyQueueRow(db, slug, "first");
    insertReplyQueueRow(db, slug, "second");
    insertReplyQueueRow(db, other, "kept");

    insertScreenshot(db, slug, "a.png");
    insertScreenshot(db, other, "b.png");

    insertCheckpoint(db, slug, "ck-target");
    insertCheckpoint(db, other, "ck-other");

    insertProviderState(db, slug);
    insertProviderState(db, other);

    await registry.delete(slug);

    const sessionRow = db.prepare(`SELECT slug FROM sessions WHERE slug = ?`).get(slug);
    assert.equal(sessionRow, undefined, "session row must be deleted");

    const transcriptCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM transcript_events WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(transcriptCount, 0, "transcript_events for slug must be deleted");

    const replyCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM reply_queue WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(replyCount, 0, "reply_queue rows for slug must be deleted");

    const screenshotCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM screenshots WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(screenshotCount, 0, "screenshots for slug must be deleted");

    const checkpointCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM checkpoints WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(checkpointCount, 0, "checkpoints for slug must be deleted");

    const providerStateCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM provider_state WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(providerStateCount, 0, "provider_state for slug must be deleted");

    const otherSession = db.prepare(`SELECT slug FROM sessions WHERE slug = ?`).get(other);
    assert.ok(otherSession, "unrelated session row must remain");
    const otherTranscript = (db
      .prepare(`SELECT COUNT(*) AS c FROM transcript_events WHERE session_slug = ?`)
      .get(other) as { c: number }).c;
    assert.equal(otherTranscript, 1, "unrelated transcript rows must remain");
    const otherReply = (db
      .prepare(`SELECT COUNT(*) AS c FROM reply_queue WHERE session_slug = ?`)
      .get(other) as { c: number }).c;
    assert.equal(otherReply, 1, "unrelated reply_queue rows must remain");
    const otherScreenshot = (db
      .prepare(`SELECT COUNT(*) AS c FROM screenshots WHERE session_slug = ?`)
      .get(other) as { c: number }).c;
    assert.equal(otherScreenshot, 1, "unrelated screenshots must remain");
    const otherCheckpoint = (db
      .prepare(`SELECT COUNT(*) AS c FROM checkpoints WHERE session_slug = ?`)
      .get(other) as { c: number }).c;
    assert.equal(otherCheckpoint, 1, "unrelated checkpoints must remain");
    const otherProviderState = (db
      .prepare(`SELECT COUNT(*) AS c FROM provider_state WHERE session_slug = ?`)
      .get(other) as { c: number }).c;
    assert.equal(otherProviderState, 1, "unrelated provider_state must remain");
  });

  test("emits session_deleted event with the deleted slug", async () => {
    const slug = "sess-emit";
    insertSession(db, slug);

    const events: SessionDeletedEvent[] = [];
    bus.on("session_deleted", (ev) => events.push(ev));

    await registry.delete(slug);

    assert.equal(events.length, 1, "exactly one session_deleted event");
    assert.equal(events[0]?.kind, "session_deleted");
    assert.equal(events[0]?.slug, slug);
  });

  test("kills the running provider handle before deleting", async () => {
    const slug = "sess-running";
    insertSession(db, slug, "running");

    const killSignals: NodeJS.Signals[] = [];
    const handle: ProviderHandle = {
      pid: 1234,
      kill(signal: NodeJS.Signals) {
        killSignals.push(signal);
      },
      write() {},
      waitForExit() {
        return new Promise(() => {});
      },
      async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {},
    };
    injectHandle(registry, slug, handle);

    await registry.delete(slug);

    assert.equal(killSignals.length, 1, "handle.kill must be called once");
    assert.equal(
      (registry as unknown as { handles: Map<string, ProviderHandle> }).handles.has(slug),
      false,
      "handle map entry must be removed",
    );
  });

  test("throws not_found for a missing slug", async () => {
    await assert.rejects(() => registry.delete("does-not-exist"), /not found/i);
  });
});
