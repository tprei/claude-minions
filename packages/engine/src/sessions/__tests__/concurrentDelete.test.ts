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
import type { SessionCreatedEvent } from "@minions/shared";

const GATED_PROVIDER = "concurrent-delete-gated-provider";

let spawnGate: Promise<void> = Promise.resolve();
let releaseSpawnGate: () => void = () => {};

function resetSpawnGate(): void {
  spawnGate = new Promise<void>((r) => {
    releaseSpawnGate = r;
  });
}

function buildIdleHandle(): ProviderHandle {
  let resolved = false;
  let exitResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r;
  });
  return {
    pid: undefined,
    externalId: "ext-id-test",
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

const gatedProvider: AgentProvider = {
  name: GATED_PROVIDER,
  async spawn(_opts: ProviderSpawnOpts): Promise<ProviderHandle> {
    await spawnGate;
    return buildIdleHandle();
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

registerProvider(gatedProvider);

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
      provider: GATED_PROVIDER,
    },
    memory: { renderPreamble: () => "" },
    runtime: { effective: () => ({}) },
  } as unknown as EngineContext;
}

describe("SessionRegistry — concurrent create vs delete", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "concurrent-delete-"));
    resetSpawnGate();
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
    releaseSpawnGate();
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("delete() during in-flight setupAndSpawn waits for spawn — no FK violation", async () => {
    const created: string[] = [];
    bus.on("session_created", (e: SessionCreatedEvent) => {
      created.push(e.session.slug);
    });

    const createPromise = registry.create({ prompt: "race test", mode: "task" });

    // Wait until session_created fires (the row is inserted before setupAndSpawn).
    while (created.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const slug = created[0]!;

    // Kick off delete while spawn is still gated. It must queue on the mutex.
    const deletePromise = registry.delete(slug);

    // Give the event loop a chance to run; delete must NOT have completed yet
    // because setupAndSpawn still holds the slug mutex.
    await new Promise((r) => setTimeout(r, 50));
    const rowDuringSpawn = db
      .prepare(`SELECT slug FROM sessions WHERE slug = ?`)
      .get(slug);
    assert.ok(
      rowDuringSpawn,
      "session row must still exist while setupAndSpawn holds the slug mutex",
    );

    // Release the spawn — setupAndSpawn finishes and releases the mutex,
    // delete acquires it and runs. No FK violations should occur.
    releaseSpawnGate();

    await assert.doesNotReject(createPromise, "create() must complete cleanly");
    await assert.doesNotReject(deletePromise, "delete() must complete cleanly");

    const rowAfter = db
      .prepare(`SELECT slug FROM sessions WHERE slug = ?`)
      .get(slug);
    assert.equal(rowAfter, undefined, "session row must be gone after delete");

    const providerStateAfter = db
      .prepare(`SELECT session_slug FROM provider_state WHERE session_slug = ?`)
      .get(slug);
    assert.equal(
      providerStateAfter,
      undefined,
      "provider_state row must be cleaned up after delete",
    );
  });
});
