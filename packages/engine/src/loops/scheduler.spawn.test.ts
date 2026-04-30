import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { CreateSessionRequest, Session } from "@minions/shared";
import { migrations } from "../store/migrations.js";
import { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { createLogger } from "../logger.js";
import type { EngineContext } from "../context.js";
import type { EngineEnv } from "../env.js";
import type { SubsystemDeps } from "../wiring.js";
import { createLoopsSubsystem } from "./index.js";

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) {
    db.exec(m.sql);
  }
  return db;
}

function makeEnv(overrides: Partial<EngineEnv> = {}): EngineEnv {
  return {
    port: 0,
    host: "127.0.0.1",
    token: "",
    corsOrigins: [],
    workspace: ":memory:",
    provider: "mock",
    logLevel: "error",
    vapid: null,
    githubApp: null,
    resourceSampleSec: 60,
    loopTickSec: 1,
    loopReservedInteractive: 0,
    ssePingSec: 60,
    apiVersion: "1",
    libraryVersion: "0.1.0",
    webDist: null,
    crashLogDir: "/tmp/minions-crashes",
    ...overrides,
  };
}

describe("Loops subsystem schedules tick exactly once", () => {
  it("spawns one session per intervalSec without double-scheduling", async () => {
    const log = createLogger("error");
    const db = makeInMemoryDb();
    const bus = new EventBus();
    const mutex = new KeyedMutex();
    const env = makeEnv();

    let createCalls = 0;
    const createRequests: CreateSessionRequest[] = [];

    const ctx = {
      env,
      log,
      db,
      bus,
      mutex,
      workspaceDir: ":memory:",
      sessions: {
        create: async (req: CreateSessionRequest): Promise<Session> => {
          createCalls += 1;
          createRequests.push(req);
          return {
            slug: `loop-spawn-${createCalls}`,
            title: req.title ?? "loop",
            prompt: req.prompt,
            mode: "loop",
            status: "completed",
            childSlugs: [],
            attention: [],
            quickActions: [],
            stats: {
              turns: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: 0,
              durationMs: 0,
              toolCalls: 0,
            },
            provider: "mock",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            metadata: req.metadata ?? {},
          };
        },
        list: (): Session[] => [],
      },
      runtime: {
        effective: () => ({}),
      },
    } as unknown as EngineContext;

    const deps: SubsystemDeps = {
      ctx,
      log,
      env,
      db,
      bus,
      mutex,
      workspaceDir: ":memory:",
    };

    const result = createLoopsSubsystem(deps);
    ctx.loops = result.api;

    result.api.upsert({
      label: "regression",
      prompt: "spawn me",
      intervalSec: 1,
      enabled: true,
      jitterPct: 0,
      maxConcurrent: 1,
    });

    await new Promise((r) => setTimeout(r, 2500));

    assert.equal(
      createCalls,
      2,
      `expected exactly 2 spawns in ~2.5s with intervalSec=1 and loopTickSec=1, got ${createCalls}`,
    );

    if (result.onShutdown) {
      await result.onShutdown();
    }

    const callsAtShutdown = createCalls;

    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(
      createCalls,
      callsAtShutdown,
      "no further ticks should fire after onShutdown",
    );

    db.close();
  });
});
