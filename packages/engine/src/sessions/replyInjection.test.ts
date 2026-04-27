import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventBus } from "../bus/eventBus.js";
import { SessionRegistry } from "./registry.js";
import { createLogger } from "../logger.js";
import { migrations } from "../store/migrations.js";
import type { ProviderHandle, ProviderEvent } from "../providers/provider.js";
import type { EngineContext } from "../context.js";
import type { TranscriptEventEvent, UserMessageEvent } from "@minions/shared";

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
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
      0, 0, 0, 0, 0, 0, 0, 0, 'mock', datetime('now'), datetime('now'), 0, '{}'
    )
  `).run(slug, "test", "prompt", status);
}

interface CollectingHandle extends ProviderHandle {
  writes: string[];
}

function makeCollectingHandle(): CollectingHandle {
  const writes: string[] = [];
  const handle: CollectingHandle = {
    pid: 1234,
    writes,
    write(text: string) {
      writes.push(text);
    },
    kill() {},
    waitForExit() {
      return new Promise(() => {});
    },
    [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
      return {
        async next() {
          return { value: undefined, done: true };
        },
      };
    },
  };
  return handle;
}

function makeStubCtx(): EngineContext {
  return {
    audit: {
      record: () => {},
      list: () => [],
    },
  } as unknown as EngineContext;
}

function injectHandle(registry: SessionRegistry, slug: string, handle: ProviderHandle): void {
  (registry as unknown as { handles: Map<string, ProviderHandle> }).handles.set(slug, handle);
}

function readUserMessages(db: Database.Database, slug: string): UserMessageEvent[] {
  const rows = db.prepare(
    `SELECT body FROM transcript_events WHERE session_slug = ? AND kind = 'user_message' ORDER BY seq ASC`,
  ).all(slug) as Array<{ body: string }>;
  return rows.map((r) => JSON.parse(r.body) as UserMessageEvent);
}

describe("SessionRegistry.reply (injection)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "reply-inj-"));
    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(),
    });
  });

  test("pending session enqueues reply and records non-injected user_message", async () => {
    const slug = "sess-pending";
    insertSession(db, slug, "pending");

    const emitted: TranscriptEventEvent[] = [];
    bus.on("transcript_event", (ev) => emitted.push(ev));

    await registry.reply(slug, "hello while pending");

    const msgs = readUserMessages(db, slug);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]?.text, "hello while pending");
    assert.equal(msgs[0]?.source, "operator");
    assert.notEqual(msgs[0]?.injected, true);

    const queueRows = db.prepare(
      `SELECT payload FROM reply_queue WHERE session_slug = ? AND delivered_at IS NULL`,
    ).all(slug) as Array<{ payload: string }>;
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0]?.payload, "hello while pending");

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.event.kind, "user_message");
  });

  test("running session with handle: two consecutive replies write to provider, both injected", async () => {
    const slug = "sess-running";
    insertSession(db, slug, "running");

    const handle = makeCollectingHandle();
    injectHandle(registry, slug, handle);

    const emitted: TranscriptEventEvent[] = [];
    bus.on("transcript_event", (ev) => emitted.push(ev));

    await registry.reply(slug, "first");
    await registry.reply(slug, "second");

    assert.deepEqual(handle.writes, ["first", "second"]);

    const msgs = readUserMessages(db, slug);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]?.text, "first");
    assert.equal(msgs[0]?.injected, true);
    assert.equal(msgs[1]?.text, "second");
    assert.equal(msgs[1]?.injected, true);

    const queueCount = (db.prepare(
      `SELECT COUNT(*) AS c FROM reply_queue WHERE session_slug = ?`,
    ).get(slug) as { c: number }).c;
    assert.equal(queueCount, 0);

    const userMsgEvents = emitted.filter((e) => e.event.kind === "user_message");
    assert.equal(userMsgEvents.length, 2);
    for (const ev of userMsgEvents) {
      assert.equal((ev.event as UserMessageEvent).injected, true);
    }
  });

  test("completed session: reply persists transcript event but does not write to provider; injected is false", async () => {
    const slug = "sess-completed";
    insertSession(db, slug, "completed");

    const handle = makeCollectingHandle();
    injectHandle(registry, slug, handle);

    await registry.reply(slug, "post-completion");

    assert.deepEqual(handle.writes, []);

    const msgs = readUserMessages(db, slug);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]?.text, "post-completion");
    assert.notEqual(msgs[0]?.injected, true);

    const queueRows = db.prepare(
      `SELECT payload FROM reply_queue WHERE session_slug = ? AND delivered_at IS NULL`,
    ).all(slug) as Array<{ payload: string }>;
    assert.equal(queueRows.length, 1);
  });
});
