import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import type {
  AttentionFlag,
  ResourceSnapshot,
  Session,
  SessionMode,
} from "@minions/shared";
import { migrations } from "../../store/migrations.js";
import { openStore } from "../../store/sqlite.js";
import { createLogger } from "../../logger.js";
import { EventBus } from "../../bus/eventBus.js";
import { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import { SessionRegistry } from "../../sessions/registry.js";
import type { EngineContext } from "../../context.js";
import {
  createSessionSpawnRetryHandler,
  enqueueSessionSpawnRetry,
  SESSION_SPAWN_RETRY_MAX_ATTEMPTS,
} from "./sessionSpawnRetry.js";

interface HandlerEnv {
  db: Database.Database;
  repo: AutomationJobRepo;
  workspaceDir: string;
  cleanup: () => void;
}

function setupHandlerEnv(): HandlerEnv {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-spawn-retry-"));
  const dbPath = path.join(tmpDir, "test.db");
  const log = createLogger("error");
  const db = openStore({ path: dbPath, log });
  const repo = new AutomationJobRepo(db);
  return {
    db,
    repo,
    workspaceDir: tmpDir,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function makeSession(slug: string, mode: SessionMode = "loop"): Session {
  const now = new Date().toISOString();
  return {
    slug,
    title: slug,
    prompt: "test",
    mode,
    status: "pending",
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
    createdAt: now,
    updatedAt: now,
    childSlugs: [],
    metadata: {},
  };
}

interface MockHandlerCtxOpts {
  session: Session | null;
  spawnResult?: { spawned: boolean; reason?: string };
}

interface MockHandlerCtxResult {
  ctx: EngineContext;
  spawnPendingCalls: string[];
  attentionAppends: { slug: string; flag: AttentionFlag }[];
  failedMarks: string[];
  audits: { action: string; detail: Record<string, unknown> }[];
}

function makeHandlerCtx(opts: MockHandlerCtxOpts): MockHandlerCtxResult {
  const spawnPendingCalls: string[] = [];
  const attentionAppends: { slug: string; flag: AttentionFlag }[] = [];
  const failedMarks: string[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];

  const ctx = {
    sessions: {
      get: (slug: string) =>
        opts.session && opts.session.slug === slug ? opts.session : null,
      spawnPending: async (slug: string) => {
        spawnPendingCalls.push(slug);
        return opts.spawnResult ?? { spawned: true };
      },
      appendAttention: (slug: string, flag: AttentionFlag) => {
        attentionAppends.push({ slug, flag });
        if (opts.session && opts.session.slug === slug) {
          opts.session.attention = [...opts.session.attention, flag];
        }
      },
      markFailed: (slug: string) => {
        failedMarks.push(slug);
        if (opts.session && opts.session.slug === slug) {
          opts.session.status = "failed";
        }
      },
    },
    audit: {
      record: (
        _actor: string,
        action: string,
        _target?: { kind: string; id: string },
        detail?: Record<string, unknown>,
      ) => {
        audits.push({ action, detail: detail ?? {} });
      },
    },
  } as unknown as EngineContext;

  return { ctx, spawnPendingCalls, attentionAppends, failedMarks, audits };
}

describe("sessionSpawnRetry handler", () => {
  it("re-evaluates admission and spawns when no longer denied", async () => {
    const env = setupHandlerEnv();
    try {
      const session = makeSession("s-spawn", "loop");
      const { ctx, spawnPendingCalls, audits } = makeHandlerCtx({
        session,
        spawnResult: { spawned: true },
      });

      const handler = createSessionSpawnRetryHandler({ repo: env.repo });
      const job = enqueueSessionSpawnRetry(env.repo, "s-spawn", 0);

      await handler(env.repo.get(job.id)!, ctx);

      assert.deepEqual(spawnPendingCalls, ["s-spawn"]);
      const followUps = env.repo
        .findByTarget("session", "s-spawn")
        .filter((j) => j.id !== job.id && j.kind === "session-spawn-retry");
      assert.equal(followUps.length, 0, "no follow-up enqueued after success");
      const spawnedAudit = audits.find((a) => a.action === "session.spawn-retry.spawned");
      assert.ok(spawnedAudit, "audit recorded for successful spawn");
    } finally {
      env.cleanup();
    }
  });

  it("re-enqueues with backoff when admission is still resource-denied", async () => {
    const env = setupHandlerEnv();
    try {
      const session = makeSession("s-defer", "loop");
      const { ctx, attentionAppends, failedMarks } = makeHandlerCtx({
        session,
        spawnResult: { spawned: false, reason: "resource:disk free 0 below floor 1" },
      });

      const handler = createSessionSpawnRetryHandler({ repo: env.repo });
      const job = enqueueSessionSpawnRetry(env.repo, "s-defer", 0);

      await handler(env.repo.get(job.id)!, ctx);

      assert.equal(attentionAppends.length, 0, "no attention appended on retry");
      assert.deepEqual(failedMarks, [], "session not marked failed on retry");

      const followUps = env.repo
        .findByTarget("session", "s-defer")
        .filter((j) => j.id !== job.id && j.kind === "session-spawn-retry");
      assert.equal(followUps.length, 1, "follow-up retry enqueued");
      assert.equal(followUps[0]!.payload["attempts"], 1);
    } finally {
      env.cleanup();
    }
  });

  it("marks session failed with attention after exhausting attempts", async () => {
    const env = setupHandlerEnv();
    try {
      const session = makeSession("s-exhaust", "loop");
      const { ctx, attentionAppends, failedMarks, audits } = makeHandlerCtx({
        session,
        spawnResult: { spawned: false, reason: "resource:memory free 0 below floor 1" },
      });

      const handler = createSessionSpawnRetryHandler({ repo: env.repo });
      const job = enqueueSessionSpawnRetry(
        env.repo,
        "s-exhaust",
        SESSION_SPAWN_RETRY_MAX_ATTEMPTS - 1,
      );

      await handler(env.repo.get(job.id)!, ctx);

      assert.deepEqual(failedMarks, ["s-exhaust"], "session marked failed");
      assert.equal(attentionAppends.length, 1, "one attention flag appended");
      const flag = attentionAppends[0]!.flag;
      assert.equal(flag.kind, "manual_intervention");
      assert.match(flag.message, /admission exhausted/);

      const followUps = env.repo
        .findByTarget("session", "s-exhaust")
        .filter((j) => j.id !== job.id && j.kind === "session-spawn-retry");
      assert.equal(followUps.length, 0, "no follow-up after exhaustion");

      const exhaustedAudit = audits.find(
        (a) => a.action === "session.spawn-retry.exhausted",
      );
      assert.ok(exhaustedAudit, "exhausted audit recorded");
    } finally {
      env.cleanup();
    }
  });

  it("returns without action when session is missing", async () => {
    const env = setupHandlerEnv();
    try {
      const { ctx, spawnPendingCalls } = makeHandlerCtx({ session: null });

      const handler = createSessionSpawnRetryHandler({ repo: env.repo });
      const job = enqueueSessionSpawnRetry(env.repo, "missing", 0);

      await handler(env.repo.get(job.id)!, ctx);

      assert.deepEqual(spawnPendingCalls, []);
    } finally {
      env.cleanup();
    }
  });

  it("returns without action when session is no longer pending", async () => {
    const env = setupHandlerEnv();
    try {
      const session = makeSession("s-running", "loop");
      session.status = "running";
      const { ctx, spawnPendingCalls } = makeHandlerCtx({ session });

      const handler = createSessionSpawnRetryHandler({ repo: env.repo });
      const job = enqueueSessionSpawnRetry(env.repo, "s-running", 0);

      await handler(env.repo.get(job.id)!, ctx);

      assert.deepEqual(spawnPendingCalls, [], "no spawn attempt for non-pending");
    } finally {
      env.cleanup();
    }
  });
});

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) {
    db.exec(m.sql);
  }
  return db;
}

function pressureSnapshot(): ResourceSnapshot {
  return {
    timestamp: new Date().toISOString(),
    cgroupAware: false,
    cpu: { usagePct: 0, limitCores: 8, cores: 8 },
    memory: {
      usedBytes: 100,
      limitBytes: 200,
      rssBytes: 0,
    },
    disk: {
      usedBytes: 100,
      totalBytes: 200,
      workspacePath: "/tmp",
      workspaceUsedBytes: 0,
    },
    eventLoop: { lagMs: 0 },
    sessions: { total: 0, running: 0, waiting: 0 },
  };
}

describe("session create() resource-pressure queueing", () => {
  it("enqueues a session-spawn-retry job (no throw) for autonomous sessions denied by resource floor", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-create-pressure-"));
    const db = makeInMemoryDb();
    const bus = new EventBus();
    const log = createLogger("error");
    try {
      const automationRepo = new AutomationJobRepo(db);

      const ctx = {
        env: { provider: "mock" },
        runtime: {
          effective: () => ({}),
        },
        resource: {
          latest: () => pressureSnapshot(),
        },
        audit: {
          record: () => {},
        },
        memory: {
          renderPreamble: () => "",
        },
        sessions: {} as EngineContext["sessions"],
        dags: {} as EngineContext["dags"],
      } as unknown as EngineContext;

      const registry = new SessionRegistry({
        db,
        bus,
        log,
        workspaceDir: tmpDir,
        ctx,
        automationRepo,
      });

      const session = await registry.create({
        prompt: "background work",
        mode: "loop",
      });

      assert.equal(session.status, "pending", "session row remains pending");

      const queuedJobs = automationRepo.findByTarget("session", session.slug);
      const spawnRetryJobs = queuedJobs.filter(
        (j) => j.kind === "session-spawn-retry",
      );
      assert.equal(
        spawnRetryJobs.length,
        1,
        "one session-spawn-retry job enqueued",
      );
      assert.equal(spawnRetryJobs[0]!.payload["slug"], session.slug);
      assert.equal(spawnRetryJobs[0]!.payload["attempts"], 0);

      registry.stopStuckPendingSweep();
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("still throws for interactive sessions denied by resource floor", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-create-pressure-int-"));
    const db = makeInMemoryDb();
    const bus = new EventBus();
    const log = createLogger("error");
    try {
      const automationRepo = new AutomationJobRepo(db);

      const ctx = {
        env: { provider: "mock" },
        runtime: { effective: () => ({}) },
        resource: { latest: () => pressureSnapshot() },
        audit: { record: () => {} },
        memory: { renderPreamble: () => "" },
        sessions: {} as EngineContext["sessions"],
        dags: {} as EngineContext["dags"],
      } as unknown as EngineContext;

      const registry = new SessionRegistry({
        db,
        bus,
        log,
        workspaceDir: tmpDir,
        ctx,
        automationRepo,
      });

      await assert.rejects(
        () => registry.create({ prompt: "interactive task", mode: "task" }),
        /Admission denied/,
      );

      const allJobs = db.prepare(`SELECT id FROM automation_jobs`).all() as { id: string }[];
      assert.equal(allJobs.length, 0, "no retry queued for interactive denial");

      registry.stopStuckPendingSweep();
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
