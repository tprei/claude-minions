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

const SPAWN_FROM_THINK_TEST_PROVIDER = "registry-spawn-from-think-test";

function buildIdleHandle(): ProviderHandle {
  let resolved = false;
  let exitResolve: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exitResolve = r;
  });
  return {
    pid: undefined,
    externalId: undefined,
    kill(signal: NodeJS.Signals) {
      if (resolved) return;
      resolved = true;
      exitResolve({ code: null, signal });
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
  name: SPAWN_FROM_THINK_TEST_PROVIDER,
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

interface AuditCall {
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function makeCtxWithAuditSpy(calls: AuditCall[]): EngineContext {
  return {
    audit: {
      record: (
        actor: string,
        action: string,
        target?: { kind: string; id: string },
        detail?: Record<string, unknown>,
      ) => {
        calls.push({ actor, action, target, detail });
      },
      list: () => [],
    },
    dags: { onSessionTerminal: async () => {} },
    ship: { onTurnCompleted: async () => {} },
    env: {
      host: "127.0.0.1",
      port: 8787,
      token: "test-token",
      provider: SPAWN_FROM_THINK_TEST_PROVIDER,
    },
    memory: { renderPreamble: () => "" },
    runtime: { effective: () => ({}) },
    resource: { latest: () => null },
  } as unknown as EngineContext;
}

describe("SessionRegistry.create spawn_from_think audit", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;
  let auditCalls: AuditCall[];

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-spawn-from-think-"));
    auditCalls = [];
    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeCtxWithAuditSpy(auditCalls),
    });
  });

  afterEach(() => {
    registry.stopStuckPendingSweep();
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("records spawn_from_think when parent is a think session", async () => {
    const parent = await registry.create({
      prompt: "research the codebase",
      mode: "think",
    });

    auditCalls.length = 0;

    const child = await registry.create({
      prompt: "do the work",
      mode: "task",
      parentSlug: parent.slug,
    });

    const match = auditCalls.find((c) => c.action === "spawn_from_think");
    assert.ok(match, "expected spawn_from_think audit record");
    assert.equal(match.actor, "operator");
    assert.deepEqual(match.target, { kind: "session", id: child.slug });
    assert.deepEqual(match.detail, { parentSlug: parent.slug, mode: "task" });
  });

  test("does not record spawn_from_think when parent is not a think session", async () => {
    const parent = await registry.create({
      prompt: "regular task",
      mode: "task",
    });

    auditCalls.length = 0;

    await registry.create({
      prompt: "child task",
      mode: "task",
      parentSlug: parent.slug,
    });

    const match = auditCalls.find((c) => c.action === "spawn_from_think");
    assert.equal(match, undefined, "spawn_from_think must not fire for non-think parents");
  });
});
