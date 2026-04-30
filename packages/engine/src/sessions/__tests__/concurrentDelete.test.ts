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

const SLOW_SPAWN_PROVIDER = "concurrent-delete-slow-provider";

function buildIdleHandle(): ProviderHandle {
  let resolved = false;
  let exitResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r;
  });
  return {
    pid: undefined,
    externalId: "ext-id",
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

let releaseSpawn: (() => void) | null = null;
let spawnReached: (() => void) | null = null;

const slowSpawnProvider: AgentProvider = {
  name: SLOW_SPAWN_PROVIDER,
  spawn(_opts: ProviderSpawnOpts): Promise<ProviderHandle> {
    return new Promise<ProviderHandle>((resolve) => {
      spawnReached?.();
      releaseSpawn = () => resolve(buildIdleHandle());
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

registerProvider(slowSpawnProvider);

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function makeStubCtx(): EngineContext {
  return {
    audit: { record: () => {}, list: () => [] },
    dags: { onSessionTerminal: async () => {} },
    ship: { onTurnCompleted: async () => {} },
    env: {
      host: "127.0.0.1",
      port: 8787,
      token: "test-token",
      provider: SLOW_SPAWN_PROVIDER,
    },
    memory: { renderPreamble: () => "" },
    runtime: { effective: () => ({}) },
  } as unknown as EngineContext;
}

describe("SessionRegistry — concurrent delete during setupAndSpawn", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "concurrent-delete-"));
    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(),
    });
  });

  afterEach(() => {
    registry.stopStuckPendingSweep();
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    releaseSpawn = null;
    spawnReached = null;
  });

  test("delete fired mid-spawn waits for spawn → no FK violation", async () => {
    const reachedSpawn = new Promise<void>((resolve) => {
      spawnReached = resolve;
    });

    const createPromise = registry.create({
      prompt: "concurrent delete prompt",
      mode: "task",
    });

    await reachedSpawn;

    const sessions = registry.list();
    assert.equal(sessions.length, 1, "session row exists in 'pending' while spawn blocks");
    const slug = sessions[0]!.slug;

    const deletePromise = registry.delete(slug);

    // give the delete a chance to acquire (or queue on) the mutex
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // session row must still be present — delete is queued behind spawn
    const rowDuring = db.prepare(`SELECT slug FROM sessions WHERE slug = ?`).get(slug);
    assert.ok(rowDuring, "delete must wait for spawn to finish before removing the row");

    releaseSpawn!();

    await createPromise;
    await deletePromise;

    const rowAfter = db.prepare(`SELECT slug FROM sessions WHERE slug = ?`).get(slug);
    assert.equal(rowAfter, undefined, "session row removed after delete completes");

    const transcriptCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM transcript_events WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(transcriptCount, 0, "child transcript rows cascade-cleaned");

    const providerStateCount = (db
      .prepare(`SELECT COUNT(*) AS c FROM provider_state WHERE session_slug = ?`)
      .get(slug) as { c: number }).c;
    assert.equal(providerStateCount, 0, "provider_state child rows removed");
  });
});
