import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Session } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { EventBus } from "../bus/eventBus.js";
import { openStore } from "../store/sqlite.js";
import { createLogger } from "../logger.js";
import { DagRepo } from "./model.js";
import { DagScheduler } from "./scheduler.js";
import { dispatchAfterBootReconcile } from "./index.js";

interface Env {
  db: ReturnType<typeof openStore>;
  bus: EventBus;
  repo: DagRepo;
  cleanup: () => void;
}

function setup(): Env {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-dag-boot-"));
  const dbPath = path.join(tmpDir, "engine.db");
  const log = createLogger("error");
  const db = openStore({ path: dbPath, log });
  const bus = new EventBus();
  const repo = new DagRepo(db, bus);
  return {
    db,
    bus,
    repo,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function makeCtx(spawned: Session[]): EngineContext {
  let counter = 0;
  return {
    sessions: {
      create: async (req: { prompt: string; mode?: string; title?: string; baseBranch?: string; metadata?: Record<string, unknown> }) => {
        const slug = `mock-sess-${++counter}`;
        const session: Session = {
          slug,
          title: req.title ?? slug,
          prompt: req.prompt,
          mode: (req.mode as Session["mode"]) ?? "task",
          status: "running",
          attention: [],
          quickActions: [],
          branch: `minions/${slug}`,
          baseBranch: req.baseBranch,
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
          childSlugs: [],
          metadata: (req.metadata ?? {}) as Record<string, unknown>,
        };
        spawned.push(session);
        return session;
      },
      get: (slug: string) => spawned.find((s) => s.slug === slug) ?? null,
      setDagId: () => {},
    },
    audit: {
      record: () => {},
    },
    runtime: {
      values: () => ({}),
    },
  } as unknown as EngineContext;
}

describe("createDagSubsystem boot dispatch", () => {
  it("ticks active DAGs after reconcile so pending nodes spawn sessions", async () => {
    const env = setup();
    try {
      const now = new Date().toISOString();
      env.repo.insert({
        id: "dag-boot",
        title: "boot-test",
        goal: "verify boot tick",
        status: "active",
        metadata: {},
        createdAt: now,
        updatedAt: now,
      });
      env.repo.insertNode(
        "dag-boot",
        {
          title: "n1",
          prompt: "do n1",
          status: "pending",
          dependsOn: [],
          metadata: {},
        },
        0,
      );

      const spawned: Session[] = [];
      const ctx = makeCtx(spawned);
      const scheduler = new DagScheduler(env.repo, ctx, createLogger("error"));

      await dispatchAfterBootReconcile(scheduler, ["dag-boot"], ctx, createLogger("error"));

      assert.equal(spawned.length, 1, "exactly one session spawned for the pending node");
      assert.equal(spawned[0]!.mode, "dag-task");
    } finally {
      env.cleanup();
    }
  });

  it("does not spawn sessions for completed DAGs", async () => {
    const env = setup();
    try {
      const now = new Date().toISOString();
      env.repo.insert({
        id: "dag-done",
        title: "done",
        goal: "g",
        status: "active",
        metadata: {},
        createdAt: now,
        updatedAt: now,
      });
      env.repo.insertNode(
        "dag-done",
        {
          title: "n1",
          prompt: "p",
          status: "landed",
          dependsOn: [],
          metadata: {},
        },
        0,
      );

      const spawned: Session[] = [];
      const ctx = makeCtx(spawned);
      const scheduler = new DagScheduler(env.repo, ctx, createLogger("error"));

      await dispatchAfterBootReconcile(scheduler, ["dag-done"], ctx, createLogger("error"));

      assert.equal(spawned.length, 0, "no session spawned for an all-landed dag");
    } finally {
      env.cleanup();
    }
  });
});
