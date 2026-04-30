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

const REGISTRY_CREATE_TEST_PROVIDER = "registry-create-budget-test";

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

const stubProvider: AgentProvider = {
  name: REGISTRY_CREATE_TEST_PROVIDER,
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

registerProvider(stubProvider);

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function makeStubCtx(
  effective: Record<string, unknown> = {},
): EngineContext {
  return {
    audit: { record: () => {}, list: () => [] },
    dags: { onSessionTerminal: async () => {} },
    ship: { onTurnCompleted: async () => {} },
    env: {
      host: "127.0.0.1",
      port: 8787,
      token: "test-token",
      provider: REGISTRY_CREATE_TEST_PROVIDER,
    },
    memory: { renderPreamble: () => "" },
    runtime: { effective: () => effective },
  } as unknown as EngineContext;
}

describe("SessionRegistry.create persists costBudgetUsd", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-create-budget-"));
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
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("persists costBudgetUsd from CreateSessionRequest", async () => {
    const session = await registry.create({
      prompt: "budgeted task",
      mode: "task",
      costBudgetUsd: 2.5,
    });

    assert.equal(session.costBudgetUsd, 2.5);

    const row = db
      .prepare(`SELECT cost_budget_usd FROM sessions WHERE slug = ?`)
      .get(session.slug) as { cost_budget_usd: number | null };
    assert.equal(row.cost_budget_usd, 2.5, "column must store the supplied numeric budget");

    const reread = registry.get(session.slug);
    assert.ok(reread);
    assert.equal(reread!.costBudgetUsd, 2.5);
  });

  test("null column round-trips to undefined", async () => {
    const session = await registry.create({
      prompt: "unbudgeted task",
      mode: "task",
    });

    assert.equal(session.costBudgetUsd, undefined);

    const row = db
      .prepare(`SELECT cost_budget_usd FROM sessions WHERE slug = ?`)
      .get(session.slug) as { cost_budget_usd: number | null };
    assert.equal(row.cost_budget_usd, null, "absent budget must store as SQL NULL");

    const reread = registry.get(session.slug);
    assert.ok(reread);
    assert.equal(
      reread!.costBudgetUsd,
      undefined,
      "rowToSession must map NULL to undefined (not null)",
    );
    assert.ok(
      !("costBudgetUsd" in reread! && reread!.costBudgetUsd === null),
      "costBudgetUsd must not be null on the in-memory Session",
    );
  });
});

describe("SessionRegistry.create runtime defaultSessionBudgetUsd fallback", () => {
  let db: Database.Database;
  let bus: EventBus;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "registry-create-budget-fallback-"),
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("runtime defaultSessionBudgetUsd seeds session.costBudgetUsd when request omits it", async () => {
    const registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx({ defaultSessionBudgetUsd: 1.25 }),
    });

    const session = await registry.create({
      prompt: "fallback task",
      mode: "task",
    });

    assert.equal(session.costBudgetUsd, 1.25);

    const row = db
      .prepare(`SELECT cost_budget_usd FROM sessions WHERE slug = ?`)
      .get(session.slug) as { cost_budget_usd: number | null };
    assert.equal(row.cost_budget_usd, 1.25);
  });

  test("explicit costBudgetUsd in request overrides runtime default", async () => {
    const registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx({ defaultSessionBudgetUsd: 5 }),
    });

    const session = await registry.create({
      prompt: "explicit budget",
      mode: "task",
      costBudgetUsd: 0.5,
    });

    assert.equal(session.costBudgetUsd, 0.5);

    const row = db
      .prepare(`SELECT cost_budget_usd FROM sessions WHERE slug = ?`)
      .get(session.slug) as { cost_budget_usd: number | null };
    assert.equal(row.cost_budget_usd, 0.5);
  });

  test("default of 0 leaves session.costBudgetUsd undefined", async () => {
    const registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx({ defaultSessionBudgetUsd: 0 }),
    });

    const session = await registry.create({
      prompt: "disabled fallback",
      mode: "task",
    });

    assert.equal(session.costBudgetUsd, undefined);

    const row = db
      .prepare(`SELECT cost_budget_usd FROM sessions WHERE slug = ?`)
      .get(session.slug) as { cost_budget_usd: number | null };
    assert.equal(row.cost_budget_usd, null);
  });
});
