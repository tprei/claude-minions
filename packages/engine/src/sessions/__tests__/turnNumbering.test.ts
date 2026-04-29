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
  ProviderResumeOpts,
  ProviderSpawnOpts,
} from "../../providers/provider.js";
import { registerProvider } from "../../providers/registry.js";
import type { EngineContext } from "../../context.js";

const TURN_TEST_PROVIDER = "turn-numbering-test";

interface ControlledHandle {
  handle: ProviderHandle;
  exit: (code?: number) => void;
}

function buildEventfulHandle(events: ProviderEvent[]): ControlledHandle {
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

const captured: {
  spawns: ProviderSpawnOpts[];
  resumes: ProviderResumeOpts[];
  controls: ControlledHandle[];
} = {
  spawns: [],
  resumes: [],
  controls: [],
};

const turnTestProvider: AgentProvider = {
  name: TURN_TEST_PROVIDER,
  async spawn(opts) {
    captured.spawns.push(opts);
    const ctrl = buildEventfulHandle([
      { kind: "turn_started" },
      { kind: "assistant_text", text: "first-turn-reply" },
      { kind: "turn_completed", outcome: "success" },
    ]);
    captured.controls.push(ctrl);
    return ctrl.handle;
  },
  async resume(opts) {
    captured.resumes.push(opts);
    const text = opts.additionalPrompt ? "second-turn-reply" : "first-turn-reply";
    const ctrl = buildEventfulHandle([
      { kind: "turn_started" },
      { kind: "assistant_text", text },
      { kind: "turn_completed", outcome: "success" },
    ]);
    captured.controls.push(ctrl);
    return ctrl.handle;
  },
  parseStreamChunk(_buf, state) {
    return { events: [], state };
  },
  detectQuotaError() {
    return false;
  },
};

registerProvider(turnTestProvider);

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
  provider: string,
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
    audit: { record: () => {}, list: () => [] },
    dags: { onSessionTerminal: async () => {} },
    ship: { onTurnCompleted: async () => {} },
    env: { host: "127.0.0.1", port: 8787, token: "test-token" },
    memory: { renderPreamble: () => "" },
  } as unknown as EngineContext;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("turn numbering across continueWithQueuedReplies", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-numbering-"));
    captured.spawns.length = 0;
    captured.resumes.length = 0;
    captured.controls.length = 0;
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

  test("resumed turn after continueWithQueuedReplies has a higher turn than the prior turn", async () => {
    const slug = "sess-turn";
    const worktree = path.join(workspaceDir, slug);
    fs.mkdirSync(worktree, { recursive: true });
    insertSession(db, slug, "running", worktree, TURN_TEST_PROVIDER);

    db.prepare(
      `INSERT INTO provider_state(session_slug, provider, external_id, last_seq, last_turn, data, updated_at)
       VALUES (?, ?, ?, 0, 0, '{}', datetime('now'))`,
    ).run(slug, TURN_TEST_PROVIDER, "ext-turn");

    await registry.resumeAllActive();
    assert.equal(captured.resumes.length, 1, "initial resume from boot");

    await waitFor(() => {
      const r = db.prepare(`SELECT stats_turns FROM sessions WHERE slug = ?`).get(slug) as
        | { stats_turns: number }
        | undefined;
      return (r?.stats_turns ?? 0) >= 1;
    });

    await registry.reply(slug, "operator-followup-msg");

    const first = captured.controls[0];
    assert.ok(first, "first handle present");
    first.exit(0);

    await waitFor(() => captured.controls.length >= 2);
    const second = captured.controls[1]!;

    await waitFor(() => {
      const rows = db
        .prepare(
          `SELECT COUNT(*) AS c FROM transcript_events WHERE session_slug = ? AND kind = 'assistant_text'`,
        )
        .get(slug) as { c: number };
      return rows.c >= 2;
    });

    second.exit(0);

    await waitFor(() => {
      const r = db.prepare(`SELECT stats_turns FROM sessions WHERE slug = ?`).get(slug) as
        | { stats_turns: number }
        | undefined;
      return (r?.stats_turns ?? 0) >= 2;
    });

    const additional = captured.resumes[1]?.additionalPrompt ?? "";
    assert.ok(
      additional.includes("operator-followup-msg"),
      "second resume should carry queued reply as additionalPrompt",
    );

    const rows = db
      .prepare(
        `SELECT seq, turn, body FROM transcript_events
         WHERE session_slug = ? AND kind = 'assistant_text' ORDER BY seq ASC`,
      )
      .all(slug) as Array<{ seq: number; turn: number; body: string }>;

    assert.equal(rows.length, 2, "expected one assistant_text per turn");

    const firstTurn = rows[0]!.turn;
    const secondTurn = rows[1]!.turn;
    assert.equal(firstTurn, 1, "first assistant_text labeled with turn 1");
    assert.equal(
      secondTurn,
      2,
      `resumed assistant_text must be turn 2 (was ${secondTurn}); both at the same turn breaks transcript-by-turn grouping`,
    );
    assert.ok(
      secondTurn > firstTurn,
      `resumed turn (${secondTurn}) must be greater than prior turn (${firstTurn})`,
    );
  });
});
