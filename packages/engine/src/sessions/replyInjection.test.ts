import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventBus } from "../bus/eventBus.js";
import { SessionRegistry } from "./registry.js";
import { createLogger } from "../logger.js";
import { migrations } from "../store/migrations.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderHandle,
  ProviderResumeOpts,
  ProviderSpawnOpts,
  ParseStreamState,
} from "../providers/provider.js";
import { registerProvider } from "../providers/registry.js";
import type { EngineContext } from "../context.js";
import type { TranscriptEventEvent, UserMessageEvent } from "@minions/shared";

const REPLY_TEST_PROVIDER_NAME = "reply-injection-test";

interface CapturedResume {
  opts: ProviderResumeOpts;
}

interface CapturedSpawn {
  opts: ProviderSpawnOpts;
}

const captured = {
  resumes: [] as CapturedResume[],
  spawns: [] as CapturedSpawn[],
};

function buildControlledHandle(): {
  handle: ProviderHandle;
  exit: (code?: number) => void;
} {
  let resolved = false;
  let exitResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r;
  });

  const handle: ProviderHandle = {
    pid: undefined,
    externalId: undefined,
    kill(_signal: NodeJS.Signals) {
      if (resolved) return;
      resolved = true;
      exitResolve({ code: null, signal: _signal });
    },
    write(_text: string) {},
    async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
      await exitPromise;
    },
    waitForExit() {
      return exitPromise;
    },
  };

  return {
    handle,
    exit: (code = 0) => {
      if (resolved) return;
      resolved = true;
      exitResolve({ code, signal: null });
    },
  };
}

const exitControls: Array<(code?: number) => void> = [];

const replyTestProvider: AgentProvider = {
  name: REPLY_TEST_PROVIDER_NAME,
  async spawn(opts) {
    captured.spawns.push({ opts });
    const { handle, exit } = buildControlledHandle();
    exitControls.push(exit);
    return handle;
  },
  async resume(opts) {
    captured.resumes.push({ opts });
    const { handle, exit } = buildControlledHandle();
    exitControls.push(exit);
    return handle;
  },
  parseStreamChunk(_buf: string, state: ParseStreamState) {
    return { events: [], state };
  },
  detectQuotaError(_text: string) {
    return false;
  },
};

registerProvider(replyTestProvider);

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function insertSession(
  db: Database.Database,
  slug: string,
  status: string,
  worktreePath: string,
  provider = "mock",
): void {
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, worktree_path, created_at, updated_at, pr_draft, metadata
    ) VALUES (
      ?, ?, ?, 'task', ?, '[]', '[]',
      0, 0, 0, 0, 0, 0, 0, 0, ?, ?, datetime('now'), datetime('now'), 0, '{}'
    )
  `).run(slug, "test", "prompt", status, provider, worktreePath);
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

function readUserMessages(db: Database.Database, slug: string): UserMessageEvent[] {
  const rows = db.prepare(
    `SELECT body FROM transcript_events WHERE session_slug = ? AND kind = 'user_message' ORDER BY seq ASC`,
  ).all(slug) as Array<{ body: string }>;
  return rows.map((r) => JSON.parse(r.body) as UserMessageEvent);
}

function pendingReplyPayloads(db: Database.Database, slug: string): string[] {
  return (db
    .prepare(
      `SELECT payload FROM reply_queue WHERE session_slug = ? AND delivered_at IS NULL ORDER BY queued_at ASC`,
    )
    .all(slug) as Array<{ payload: string }>).map((r) => r.payload);
}

describe("SessionRegistry.reply (queue contract)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "reply-inj-"));
    captured.resumes.length = 0;
    captured.spawns.length = 0;
    exitControls.length = 0;
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

  test("pending session enqueues reply and emits user_message transcript event", async () => {
    const slug = "sess-pending";
    insertSession(db, slug, "pending", path.join(workspaceDir, slug));

    const emitted: TranscriptEventEvent[] = [];
    bus.on("transcript_event", (ev) => emitted.push(ev));

    await registry.reply(slug, "hello while pending");

    const msgs = readUserMessages(db, slug);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]?.text, "hello while pending");
    assert.equal(msgs[0]?.source, "operator");
    assert.notEqual(msgs[0]?.injected, true, "injected flag should not be set under queue contract");

    assert.deepEqual(pendingReplyPayloads(db, slug), ["hello while pending"]);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.event.kind, "user_message");
  });

  test("running session: reply enqueues; never writes to handle.stdin", async () => {
    const slug = "sess-running";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertSession(db, slug, "running", worktree);

    const writes: string[] = [];
    const handle: ProviderHandle = {
      pid: 1234,
      kill() {},
      write(text: string) {
        writes.push(text);
      },
      waitForExit() {
        return new Promise(() => {});
      },
      async *[Symbol.asyncIterator]() {},
    };
    injectHandle(registry, slug, handle);

    await registry.reply(slug, "first-payload-zzz");
    await registry.reply(slug, "second-payload-zzz");

    assert.deepEqual(writes, [], "handle.stdin must not receive replies (claude --print does not read stdin)");
    assert.deepEqual(pendingReplyPayloads(db, slug), [
      "first-payload-zzz",
      "second-payload-zzz",
    ]);

    const msgs = readUserMessages(db, slug);
    assert.equal(msgs.length, 2);
  });

  test("on next turn (handle exit), queued replies are delivered to provider.resume via additionalPrompt", async () => {
    const slug = "sess-deliver";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertSession(db, slug, "running", worktree, REPLY_TEST_PROVIDER_NAME);

    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, REPLY_TEST_PROVIDER_NAME, "ext-abc");

    await registry.resumeAllActive();

    assert.equal(captured.resumes.length, 1, "resumeAllActive triggers initial resume");
    assert.equal(captured.resumes[0]?.opts.additionalPrompt, undefined);

    const tag = "UNIQUE-TAG-XK4Q9";
    await registry.reply(slug, `hello agent ${tag}`);

    assert.deepEqual(pendingReplyPayloads(db, slug), [`hello agent ${tag}`]);

    const firstExit = exitControls[0];
    assert.ok(firstExit, "first handle should be exit-controllable");
    firstExit(0);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(captured.resumes.length, 2, "drain hook resumes session with queued replies");
    const additional = captured.resumes[1]?.opts.additionalPrompt ?? "";
    assert.ok(
      additional.includes(tag),
      `additionalPrompt should contain the operator reply tag (got: ${additional})`,
    );

    assert.deepEqual(pendingReplyPayloads(db, slug), [], "queue is drained after delivery");
  });

  test("two consecutive replies are joined into a single additionalPrompt on next turn", async () => {
    const slug = "sess-join";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertSession(db, slug, "running", worktree, REPLY_TEST_PROVIDER_NAME);

    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, REPLY_TEST_PROVIDER_NAME, "ext-join");

    await registry.resumeAllActive();

    await registry.reply(slug, "TAGA-aaa");
    await registry.reply(slug, "TAGB-bbb");

    const firstExit = exitControls[0];
    assert.ok(firstExit);
    firstExit(0);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(captured.resumes.length, 2);
    const additional = captured.resumes[1]?.opts.additionalPrompt ?? "";
    assert.ok(additional.includes("TAGA-aaa"));
    assert.ok(additional.includes("TAGB-bbb"));
    assert.ok(
      additional.indexOf("TAGA-aaa") < additional.indexOf("TAGB-bbb"),
      "replies preserved in queue order",
    );
  });
});
