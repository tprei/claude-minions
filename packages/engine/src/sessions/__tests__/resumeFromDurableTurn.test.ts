import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventBus } from "../../bus/eventBus.js";
import { SessionRegistry } from "../registry.js";
import { createLogger } from "../../logger.js";
import { migrations } from "../../store/migrations.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderHandle,
} from "../../providers/provider.js";
import { registerProvider } from "../../providers/registry.js";
import type { EngineContext } from "../../context.js";

const DURABLE_TURN_PROVIDER = "durable-turn-test";

interface ControlledHandle {
  handle: ProviderHandle;
  exit: (code?: number) => void;
}

function buildEventfulHandle(events: ProviderEvent[], externalId = "durable-ext-id"): ControlledHandle {
  let resolved = false;
  let exitResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r;
  });
  const handle: ProviderHandle = {
    pid: undefined,
    externalId,
    kill(_signal: NodeJS.Signals) {
      if (resolved) return;
      resolved = true;
      exitResolve({ code: null, signal: _signal });
    },
    write(_text: string) {},
    async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
      for (const ev of events) yield ev;
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

let resumeCallCount = 0;
let latestResumeCtrl: ControlledHandle | null = null;

const durableTurnProvider: AgentProvider = {
  name: DURABLE_TURN_PROVIDER,
  async spawn() {
    return buildEventfulHandle([]).handle;
  },
  async resume() {
    resumeCallCount++;
    if (resumeCallCount === 1) {
      latestResumeCtrl = buildEventfulHandle([
        { kind: "turn_started" },
        { kind: "assistant_text", text: "turn-1" },
        { kind: "turn_completed", outcome: "success" },
        { kind: "turn_started" },
        { kind: "assistant_text", text: "turn-2" },
        { kind: "turn_completed", outcome: "success" },
        { kind: "turn_started" },
        { kind: "assistant_text", text: "turn-3" },
        { kind: "turn_completed", outcome: "success" },
      ]);
    } else {
      latestResumeCtrl = buildEventfulHandle([
        { kind: "turn_started" },
        { kind: "assistant_text", text: "turn-4" },
        { kind: "turn_completed", outcome: "success" },
      ]);
    }
    return latestResumeCtrl.handle;
  },
  parseStreamChunk(_buf, state) {
    return { events: [], state };
  },
  detectQuotaError() {
    return false;
  },
};

registerProvider(durableTurnProvider);

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function insertSession(
  db: Database.Database,
  slug: string,
  worktreePath: string,
): void {
  db.prepare(`
    INSERT INTO sessions(
      slug, title, prompt, mode, status, attention, quick_actions,
      stats_turns, stats_input_tokens, stats_output_tokens,
      stats_cache_read_tokens, stats_cache_creation_tokens,
      stats_cost_usd, stats_duration_ms, stats_tool_calls,
      provider, worktree_path, created_at, updated_at, pr_draft, metadata
    ) VALUES (
      ?, ?, ?, 'task', 'running', '[]', '[]',
      0, 0, 0, 0, 0, 0, 0, 0, ?, ?, datetime('now'), datetime('now'), 0, '{}'
    )
  `).run(slug, "test", "prompt", DURABLE_TURN_PROVIDER, worktreePath);
}

function makeStubCtx(): EngineContext {
  return {
    audit: { record: () => {}, list: () => [] },
    dags: { onSessionTerminal: async () => {} },
    ship: { onTurnCompleted: async () => {} },
    env: { host: "127.0.0.1", port: 8787, token: "test-token" },
    memory: { renderPreamble: () => "" },
    resource: { latest: () => ({}) },
    runtime: {
      schema: () => ({ groups: [], fields: [] }),
      values: () => ({}),
      effective: () => ({}),
      update: async () => {},
    },
  } as unknown as EngineContext;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("resume from durable turn", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-turn-"));
    resumeCallCount = 0;
    latestResumeCtrl = null;
    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(),
    });
    registry.stopStuckPendingSweep();
  });

  afterEach(() => {
    db.close();
  });

  test("transcriptCollector writes last_seq and last_turn to provider_state after three turns", async () => {
    const slug = "sess-ps-write";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });

    insertSession(db, slug, worktree);
    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, DURABLE_TURN_PROVIDER, "durable-ext-id");

    await registry.resumeAllActive();

    await waitFor(() => {
      const r = db
        .prepare(`SELECT stats_turns FROM sessions WHERE slug = ?`)
        .get(slug) as { stats_turns: number } | undefined;
      return (r?.stats_turns ?? 0) >= 3;
    });

    const psRow = db
      .prepare(`SELECT last_seq, last_turn FROM provider_state WHERE session_slug = ?`)
      .get(slug) as { last_seq: number; last_turn: number } | undefined;

    assert.ok(psRow, "provider_state row must exist");
    assert.ok(psRow.last_seq > 0, `last_seq must be > 0 after events were written, got ${psRow.last_seq}`);
    assert.equal(psRow.last_turn, 3, `last_turn must be 3 after three turns, got ${psRow.last_turn}`);
  });

  test("resumeAllActive on a fresh registry passes durable last_turn and turn 4 events have no duplicate seqs", async () => {
    const slug = "sess-durable-restart";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });

    insertSession(db, slug, worktree);
    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, DURABLE_TURN_PROVIDER, "durable-ext-id");

    await registry.resumeAllActive();

    await waitFor(() => {
      const r = db
        .prepare(`SELECT stats_turns FROM sessions WHERE slug = ?`)
        .get(slug) as { stats_turns: number } | undefined;
      return (r?.stats_turns ?? 0) >= 3;
    });

    const psAfterFirst = db
      .prepare(`SELECT last_turn FROM provider_state WHERE session_slug = ?`)
      .get(slug) as { last_turn: number } | undefined;
    assert.equal(psAfterFirst?.last_turn, 3, "last_turn must be 3 before simulated restart");

    db.prepare(`UPDATE sessions SET status = 'running' WHERE slug = ?`).run(slug);

    const registry2 = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(),
    });
    registry2.stopStuckPendingSweep();

    await registry2.resumeAllActive();

    await waitFor(() => resumeCallCount >= 2);

    await waitFor(() => {
      const r = db
        .prepare(`SELECT stats_turns FROM sessions WHERE slug = ?`)
        .get(slug) as { stats_turns: number } | undefined;
      return (r?.stats_turns ?? 0) >= 4;
    });

    const allEvents = db
      .prepare(`SELECT seq, turn FROM transcript_events WHERE session_slug = ? ORDER BY seq ASC`)
      .all(slug) as Array<{ seq: number; turn: number }>;

    const seqs = allEvents.map((r) => r.seq);
    const uniqueSeqs = new Set(seqs);
    assert.equal(seqs.length, uniqueSeqs.size, "no duplicate seq numbers after resume");

    const turn4Events = allEvents.filter((r) => r.turn === 4);
    assert.ok(turn4Events.length > 0, "events labeled turn 4 must exist after resume");

    const turn3Events = allEvents.filter((r) => r.turn === 3);
    const turn3Seqs = new Set(turn3Events.map((r) => r.seq));
    for (const r of turn4Events) {
      assert.ok(!turn3Seqs.has(r.seq), `seq ${r.seq} appears in both turn 3 and turn 4`);
    }

    const psAfterResume = db
      .prepare(`SELECT last_turn FROM provider_state WHERE session_slug = ?`)
      .get(slug) as { last_turn: number } | undefined;
    assert.ok(
      (psAfterResume?.last_turn ?? 0) >= 4,
      `last_turn must be >= 4 after turn-4 resume events, got ${psAfterResume?.last_turn}`,
    );
  });
});
