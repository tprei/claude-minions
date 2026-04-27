import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { EventBus } from "../bus/eventBus.js";
import { TranscriptCollector } from "./transcriptCollector.js";
import { createLogger } from "../logger.js";
import { migrations } from "../store/migrations.js";
import type { ProviderEvent } from "../providers/provider.js";
import type { TranscriptEventEvent } from "@minions/shared";

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) {
    db.exec(m.sql);
  }
  return db;
}

function insertTestSession(db: Database.Database, slug: string): void {
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
  `).run(slug, "Test", "test prompt");
}

describe("TranscriptCollector", () => {
  let db: Database.Database;
  let bus: EventBus;
  let collector: TranscriptCollector;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    collector = new TranscriptCollector({ db, bus, log: createLogger("error") });
  });

  test("collects assistant_text event and persists to db", async () => {
    const slug = "test-session-1";
    insertTestSession(db, slug);

    const events: ProviderEvent[] = [
      { kind: "turn_started" },
      { kind: "assistant_text", text: "Hello, world!" },
      { kind: "turn_completed", outcome: "success" },
    ];

    async function* gen(): AsyncIterable<ProviderEvent> {
      for (const ev of events) yield ev;
    }

    const emitted: TranscriptEventEvent[] = [];
    bus.on("transcript_event", (ev) => emitted.push(ev));

    await collector.collect(slug, gen());

    const rows = db.prepare(`SELECT * FROM transcript_events WHERE session_slug = ? ORDER BY seq`).all(slug);
    assert.equal(rows.length, 3);

    const kinds = rows.map((r) => (r as { kind: string }).kind);
    assert.deepEqual(kinds, ["turn_started", "assistant_text", "turn_completed"]);

    assert.equal(emitted.length, 3);
    assert.equal(emitted[1]?.event.kind, "assistant_text");
    assert.equal((emitted[1]?.event as { kind: "assistant_text"; text: string }).text, "Hello, world!");
  });

  test("dedupes by (session, seq) via INSERT OR IGNORE", async () => {
    const slug = "test-session-2";
    insertTestSession(db, slug);

    const events: ProviderEvent[] = [
      { kind: "assistant_text", text: "First" },
    ];

    async function* gen(): AsyncIterable<ProviderEvent> {
      for (const ev of events) yield ev;
    }

    await collector.collect(slug, gen());

    const countBefore = (db.prepare(`SELECT COUNT(*) as c FROM transcript_events WHERE session_slug = ?`).get(slug) as { c: number }).c;
    assert.equal(countBefore, 1);

    await collector.collect(slug, gen());

    const countAfter = (db.prepare(`SELECT COUNT(*) as c FROM transcript_events WHERE session_slug = ?`).get(slug) as { c: number }).c;
    assert.equal(countAfter, 2);
  });

  test("flips status to running on first event", async () => {
    const slug = "test-session-3";
    insertTestSession(db, slug);

    const events: ProviderEvent[] = [
      { kind: "turn_started" },
      { kind: "turn_completed", outcome: "success" },
    ];

    async function* gen(): AsyncIterable<ProviderEvent> {
      for (const ev of events) yield ev;
    }

    const updatedStatuses: string[] = [];
    bus.on("session_updated", (ev) => updatedStatuses.push(ev.session.status));

    await collector.collect(slug, gen());

    assert.ok(updatedStatuses.includes("running"), "should emit running status");
  });

  test("flips status to waiting_input on needs_input outcome", async () => {
    const slug = "test-session-4";
    insertTestSession(db, slug);

    const events: ProviderEvent[] = [
      { kind: "turn_started" },
      { kind: "turn_completed", outcome: "needs_input" },
    ];

    async function* gen(): AsyncIterable<ProviderEvent> {
      for (const ev of events) yield ev;
    }

    await collector.collect(slug, gen());

    const row = db.prepare(`SELECT status FROM sessions WHERE slug = ?`).get(slug) as { status: string } | undefined;
    assert.equal(row?.status, "waiting_input");
  });

  test("increments turn counter on turn_completed", async () => {
    const slug = "test-session-5";
    insertTestSession(db, slug);

    const events: ProviderEvent[] = [
      { kind: "turn_started" },
      { kind: "turn_completed", outcome: "success" },
      { kind: "turn_started" },
      { kind: "turn_completed", outcome: "success" },
    ];

    async function* gen(): AsyncIterable<ProviderEvent> {
      for (const ev of events) yield ev;
    }

    await collector.collect(slug, gen());

    const row = db.prepare(`SELECT stats_turns FROM sessions WHERE slug = ?`).get(slug) as { stats_turns: number } | undefined;
    assert.equal(row?.stats_turns, 2);
  });

  test("increments tool_calls counter", async () => {
    const slug = "test-session-6";
    insertTestSession(db, slug);

    const events: ProviderEvent[] = [
      { kind: "turn_started" },
      { kind: "tool_call", toolCallId: "tc1", toolName: "Read", input: { file_path: "/foo" } },
      { kind: "tool_result", toolCallId: "tc1", status: "ok", body: "content" },
      { kind: "turn_completed", outcome: "success" },
    ];

    async function* gen(): AsyncIterable<ProviderEvent> {
      for (const ev of events) yield ev;
    }

    await collector.collect(slug, gen());

    const row = db.prepare(`SELECT stats_tool_calls FROM sessions WHERE slug = ?`).get(slug) as { stats_tool_calls: number } | undefined;
    assert.equal(row?.stats_tool_calls, 1);
  });

  test("session_id event triggers onExternalId callback", async () => {
    const slug = "test-session-7";
    insertTestSession(db, slug);

    const events: ProviderEvent[] = [
      { kind: "session_id", externalId: "ext-abc-123" },
      { kind: "turn_started" },
      { kind: "turn_completed", outcome: "success" },
    ];

    async function* gen(): AsyncIterable<ProviderEvent> {
      for (const ev of events) yield ev;
    }

    let capturedId: string | undefined;
    await collector.collect(slug, gen(), (id) => {
      capturedId = id;
    });

    assert.equal(capturedId, "ext-abc-123");
  });
});
