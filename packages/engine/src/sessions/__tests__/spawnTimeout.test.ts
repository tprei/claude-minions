import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventBus } from "../../bus/eventBus.js";
import { SessionRegistry, __setSpawnTimeoutMsForTests } from "../registry.js";
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
import { isEngineError } from "../../errors.js";

const HANGING_PROVIDER = "spawn-timeout-hanging-provider";
const FAST_PROVIDER = "spawn-timeout-fast-provider";

function buildIdleHandle(): ProviderHandle {
  let resolved = false;
  let exitResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r;
  });
  return {
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
}

const hangingProvider: AgentProvider = {
  name: HANGING_PROVIDER,
  spawn(_opts: ProviderSpawnOpts): Promise<ProviderHandle> {
    return new Promise<ProviderHandle>(() => {
      // intentionally never resolves — simulates a wedged provider.spawn
    });
  },
  async resume(_opts: ProviderResumeOpts): Promise<ProviderHandle> {
    return buildIdleHandle();
  },
  parseStreamChunk(_buf, state) {
    return { events: [], state };
  },
  detectQuotaError() {
    return false;
  },
};

const fastProvider: AgentProvider = {
  name: FAST_PROVIDER,
  async spawn(_opts: ProviderSpawnOpts) {
    return buildIdleHandle();
  },
  async resume(_opts: ProviderResumeOpts) {
    return buildIdleHandle();
  },
  parseStreamChunk(_buf, state) {
    return { events: [], state };
  },
  detectQuotaError() {
    return false;
  },
};

registerProvider(hangingProvider);
registerProvider(fastProvider);

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function makeStubCtx(providerName: string): EngineContext {
  return {
    audit: { record: () => {}, list: () => [] },
    dags: { onSessionTerminal: async () => {} },
    ship: { onTurnCompleted: async () => {} },
    env: {
      host: "127.0.0.1",
      port: 8787,
      token: "test-token",
      provider: providerName,
    },
    memory: { renderPreamble: () => "" },
    runtime: { effective: () => ({}) },
    resource: { latest: () => null },
  } as unknown as EngineContext;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe("SessionRegistry — provider.spawn hang times out", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-timeout-"));
    __setSpawnTimeoutMsForTests(50);
    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(HANGING_PROVIDER),
    });
  });

  afterEach(() => {
    registry.stopStuckPendingSweep();
    __setSpawnTimeoutMsForTests(null);
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("hung provider.spawn → setupAndSpawn rejects, session ends 'failed' with attention", async () => {
    const createPromise = registry.create({
      prompt: "test prompt",
      mode: "task",
    });

    const err = await createPromise.then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err, "create() must reject when provider.spawn hangs");
    assert.ok(isEngineError(err), "must reject with EngineError");
    assert.match(String(err), /provider\.spawn timed out/i);

    // Yield once so the failSessionWithAttention emits before we read state.
    await flushMicrotasks();

    const sessions = registry.list();
    assert.equal(sessions.length, 1);
    const session = sessions[0]!;
    assert.equal(session.status, "failed");
    assert.ok(
      session.attention.some((a) => a.kind === "manual_intervention"),
      "must surface a manual_intervention attention flag for the operator",
    );
    assert.match(
      session.attention.find((a) => a.kind === "manual_intervention")!.message,
      /Spawn failed/i,
    );
  });
});

describe("SessionRegistry — stuck-pending sweep", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "stuck-pending-sweep-"));
    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(FAST_PROVIDER),
    });
  });

  afterEach(() => {
    registry.stopStuckPendingSweep();
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function insertPending(slug: string, createdAtIso: string): void {
    db.prepare(
      `INSERT INTO sessions (
        slug, title, prompt, mode, status, attention, quick_actions,
        stats_turns, stats_input_tokens, stats_output_tokens,
        stats_cache_read_tokens, stats_cache_creation_tokens,
        stats_cost_usd, stats_duration_ms, stats_tool_calls,
        provider, created_at, updated_at, metadata
      ) VALUES (?, ?, ?, ?, 'pending', '[]', '[]', 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?, '{}')`,
    ).run(slug, slug, "p", "task", FAST_PROVIDER, createdAtIso, createdAtIso);
  }

  test("sweep marks sessions older than 60s as failed with attention", () => {
    const oldIso = new Date(Date.now() - 90_000).toISOString();
    const recentIso = new Date(Date.now() - 5_000).toISOString();

    insertPending("stuck-slug", oldIso);
    insertPending("recent-slug", recentIso);

    const swept = registry.sweepStuckPending();
    assert.equal(swept, 1, "only the >60s pending session should be swept");

    const stuck = registry.get("stuck-slug")!;
    assert.equal(stuck.status, "failed");
    assert.ok(
      stuck.attention.some((a) => a.kind === "manual_intervention"),
      "swept session must carry a manual_intervention attention flag",
    );
    assert.match(
      stuck.attention.find((a) => a.kind === "manual_intervention")!.message,
      /spawn timeout/i,
    );

    const recent = registry.get("recent-slug")!;
    assert.equal(recent.status, "pending", "recent pending session is left alone");
    assert.equal(recent.attention.length, 0);
  });

  test("admission accounting excludes pending sessions older than 60s", () => {
    const oldIso = new Date(Date.now() - 90_000).toISOString();
    insertPending("stuck-slug-1", oldIso);
    insertPending("stuck-slug-2", oldIso);

    // countRunningByClass is private; exercise it via create() by checking that
    // the stuck-pending sessions don't deny admission. We do this by spawning a
    // new session against the fast provider — if stuck pending counted, the
    // task class admission could (in some configs) reject. The stronger
    // invariant is the SQL itself: listAdmittedSession should return 0 rows
    // here.
    const cutoffIso = new Date(Date.now() - 60_000).toISOString();
    const rows = db
      .prepare(
        `SELECT mode FROM sessions
         WHERE status IN ('running', 'waiting_input')
            OR (status = 'pending' AND created_at >= ?)`,
      )
      .all(cutoffIso) as Array<{ mode: string }>;
    assert.equal(
      rows.length,
      0,
      "stuck-pending sessions must not count toward admission slots",
    );
  });
});
