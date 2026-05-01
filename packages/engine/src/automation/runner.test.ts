import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { openStore } from "../store/sqlite.js";
import { createLogger } from "../logger.js";
import { AutomationJobRepo } from "../store/repos/automationJobRepo.js";
import type { EngineContext } from "../context.js";
import { createAutomationRunner } from "./runner.js";
import type { JobHandler } from "./types.js";

function setup(): {
  db: Database.Database;
  repo: AutomationJobRepo;
  ctx: EngineContext;
  log: ReturnType<typeof createLogger>;
  cleanup: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-runner-"));
  const dbPath = path.join(tmpDir, "test.db");
  const log = createLogger("error");
  const db = openStore({ path: dbPath, log });
  const repo = new AutomationJobRepo(db);
  const ctx = {} as EngineContext;
  return {
    db,
    repo,
    ctx,
    log,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

const noopSetInterval = (() => ({ unref: () => {} })) as unknown as typeof setInterval;

describe("AutomationRunner", () => {
  it("happy path — tickOnce runs handler and marks job succeeded", async () => {
    const env = setup();
    try {
      const calls: string[] = [];
      const handler: JobHandler = async (job) => {
        calls.push(job.id);
      };
      const runner = createAutomationRunner({
        repo: env.repo,
        ctx: env.ctx,
        log: env.log,
        handlers: new Map<string, JobHandler>([["test.ok", handler]]),
        tickIntervalMs: 60_000,
        setIntervalFn: noopSetInterval,
      });
      const job = env.repo.enqueue({ kind: "test.ok" });

      const claimed = await runner.tickOnce();

      assert.equal(claimed, 1);
      assert.deepEqual(calls, [job.id]);
      const after = env.repo.get(job.id);
      assert.equal(after?.status, "succeeded");
      assert.equal(after?.leaseOwner, undefined);
    } finally {
      env.cleanup();
    }
  });

  it("failing handler increments attempts and re-schedules with backoff", async () => {
    const env = setup();
    try {
      const handler: JobHandler = async () => {
        throw new Error("boom");
      };
      const runner = createAutomationRunner({
        repo: env.repo,
        ctx: env.ctx,
        log: env.log,
        handlers: new Map<string, JobHandler>([["test.fail", handler]]),
        tickIntervalMs: 60_000,
        setIntervalFn: noopSetInterval,
      });
      const job = env.repo.enqueue({ kind: "test.fail", maxAttempts: 5 });
      const beforeMs = Date.now();

      const claimed = await runner.tickOnce();

      assert.equal(claimed, 1);
      const after = env.repo.get(job.id);
      assert.ok(after);
      assert.equal(after.status, "pending");
      assert.equal(after.attempts, 1);
      assert.equal(after.lastError, "boom");
      const nextMs = new Date(after.nextRunAt).getTime();
      assert.ok(
        nextMs >= beforeMs,
        `nextRunAt (${after.nextRunAt}) should be at/after fail moment`,
      );
      assert.ok(
        nextMs <= Date.now() + 1_500,
        `nextRunAt (${after.nextRunAt}) should be within ~1s backoff window`,
      );
    } finally {
      env.cleanup();
    }
  });

  it("exhausted attempts mark the job as failed", async () => {
    const env = setup();
    try {
      const handler: JobHandler = async () => {
        throw new Error("nope");
      };
      const runner = createAutomationRunner({
        repo: env.repo,
        ctx: env.ctx,
        log: env.log,
        handlers: new Map<string, JobHandler>([["test.fail", handler]]),
        tickIntervalMs: 60_000,
        setIntervalFn: noopSetInterval,
      });
      const job = env.repo.enqueue({ kind: "test.fail", maxAttempts: 1 });

      await runner.tickOnce();

      const after = env.repo.get(job.id);
      assert.equal(after?.status, "failed");
      assert.equal(after?.attempts, 1);
      assert.equal(after?.lastError, "nope");
    } finally {
      env.cleanup();
    }
  });

  it("releases expired leases on boot via start()", async () => {
    const env = setup();
    try {
      const job = env.repo.enqueue({ kind: "test.ok", runAt: "2026-01-01T00:00:00.000Z" });
      const claimed = env.repo.claimNextDue(
        "2026-01-01T00:00:00.000Z",
        "previous-runner",
        1_000,
      );
      assert.ok(claimed);
      assert.equal(claimed.status, "running");

      const runner = createAutomationRunner({
        repo: env.repo,
        ctx: env.ctx,
        log: env.log,
        handlers: new Map<string, JobHandler>(),
        now: () => new Date("2030-01-01T00:00:00.000Z"),
        tickIntervalMs: 60_000,
        setIntervalFn: noopSetInterval,
      });
      runner.start();

      const after = env.repo.get(job.id);
      assert.equal(after?.status, "pending");
      assert.equal(after?.leaseOwner, undefined);
      assert.equal(after?.leaseExpiresAt, undefined);

      await runner.stop();
    } finally {
      env.cleanup();
    }
  });

  it("unknown handler kind fails the job with a descriptive error", async () => {
    const env = setup();
    try {
      const runner = createAutomationRunner({
        repo: env.repo,
        ctx: env.ctx,
        log: env.log,
        handlers: new Map<string, JobHandler>(),
        tickIntervalMs: 60_000,
        setIntervalFn: noopSetInterval,
      });
      const job = env.repo.enqueue({ kind: "unregistered", maxAttempts: 1 });

      await runner.tickOnce();

      const after = env.repo.get(job.id);
      assert.equal(after?.status, "failed");
      assert.match(after?.lastError ?? "", /unknown handler: unregistered/);
    } finally {
      env.cleanup();
    }
  });
});
