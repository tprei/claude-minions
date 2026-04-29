import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { UserMessageEvent } from "@minions/shared";
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

const SEED_TEST_PROVIDER = "seed-prompt-test";

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

const seedTestProvider: AgentProvider = {
  name: SEED_TEST_PROVIDER,
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

registerProvider(seedTestProvider);

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
      provider: SEED_TEST_PROVIDER,
    },
    memory: { renderPreamble: () => "" },
    runtime: { effective: () => ({}) },
  } as unknown as EngineContext;
}

describe("SessionRegistry.create writes the seed prompt as transcript[0]", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-prompt-"));
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

  test("freshly created task session has the seed prompt as a user_message at seq 0", async () => {
    const prompt = "investigate the seed-message regression";
    const session = await registry.create({ prompt, mode: "task" });

    const transcript = registry.transcript(session.slug);
    assert.ok(transcript.length >= 1, "transcript must contain the seed user_message");

    const first = transcript[0]!;
    assert.equal(first.kind, "user_message", "transcript[0] must be a user_message");
    assert.equal(first.seq, 0, "seed user_message must occupy seq 0");

    const seed = first as UserMessageEvent;
    assert.equal(seed.text, prompt, "seed user_message text must match req.prompt");
    assert.equal(seed.source, "operator", "seed user_message must mark the operator as source");
  });

  test("subsequent transcript events from the provider stream do not collide with the seed at seq 0", async () => {
    const session = await registry.create({ prompt: "second-test", mode: "task" });

    const rows = db
      .prepare(
        `SELECT seq, kind FROM transcript_events WHERE session_slug = ? AND seq = 0`,
      )
      .all(session.slug) as Array<{ seq: number; kind: string }>;

    assert.equal(rows.length, 1, "exactly one row should occupy seq 0");
    assert.equal(rows[0]?.kind, "user_message", "seq 0 must be the seed user_message");
  });
});
