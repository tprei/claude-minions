import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { openStore } from "../sqlite.js";
import { createLogger } from "../../logger.js";
import { AutomationJobRepo } from "./automationJobRepo.js";

function setup(): { db: Database.Database; repo: AutomationJobRepo; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-automation-"));
  const dbPath = path.join(tmpDir, "test.db");
  const log = createLogger("error");
  const db = openStore({ path: dbPath, log });
  const repo = new AutomationJobRepo(db);
  return { db, repo, tmpDir };
}

describe("AutomationJobRepo", () => {
  describe("enqueue + findByTarget", () => {
    const { db, repo, tmpDir } = setup();
    after(() => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("round-trips a job", () => {
      const job = repo.enqueue({
        kind: "merge.attempt",
        targetKind: "session",
        targetId: "sess-1",
        payload: { reason: "ready" },
      });
      assert.equal(job.kind, "merge.attempt");
      assert.equal(job.targetKind, "session");
      assert.equal(job.targetId, "sess-1");
      assert.deepEqual(job.payload, { reason: "ready" });
      assert.equal(job.status, "pending");
      assert.equal(job.attempts, 0);
      assert.equal(job.maxAttempts, 5);

      const found = repo.findByTarget("session", "sess-1");
      assert.equal(found.length, 1);
      assert.equal(found[0]!.id, job.id);
    });

    it("findByTarget returns multiple jobs ordered by createdAt", () => {
      repo.enqueue({ kind: "k1", targetKind: "session", targetId: "sess-2" });
      repo.enqueue({ kind: "k2", targetKind: "session", targetId: "sess-2" });
      const found = repo.findByTarget("session", "sess-2");
      assert.equal(found.length, 2);
      assert.equal(found[0]!.kind, "k1");
      assert.equal(found[1]!.kind, "k2");
    });
  });

  describe("claimNextDue", () => {
    const { db, repo, tmpDir } = setup();
    after(() => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("is atomic — two concurrent claims, only one wins", () => {
      const job = repo.enqueue({ kind: "k", runAt: "2026-01-01T00:00:00.000Z" });

      const now = "2026-01-01T00:00:01.000Z";
      const claimA = repo.claimNextDue(now, "worker-a", 60_000);
      const claimB = repo.claimNextDue(now, "worker-b", 60_000);

      assert.ok(claimA, "first claim should succeed");
      assert.equal(claimA.id, job.id);
      assert.equal(claimA.status, "running");
      assert.equal(claimA.leaseOwner, "worker-a");
      assert.equal(claimB, null, "second claim should return null");
    });

    it("respects next_run_at — does not claim future jobs", () => {
      const fresh = setup();
      try {
        fresh.repo.enqueue({ kind: "future", runAt: "2030-01-01T00:00:00.000Z" });
        const claim = fresh.repo.claimNextDue("2026-01-01T00:00:00.000Z", "worker", 60_000);
        assert.equal(claim, null);
      } finally {
        fresh.db.close();
        fs.rmSync(fresh.tmpDir, { recursive: true, force: true });
      }
    });

    it("returns null when there are no pending jobs", () => {
      const fresh = setup();
      try {
        const claim = fresh.repo.claimNextDue("2030-01-01T00:00:00.000Z", "worker", 60_000);
        assert.equal(claim, null);
      } finally {
        fresh.db.close();
        fs.rmSync(fresh.tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("fail", () => {
    const { db, repo, tmpDir } = setup();
    after(() => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("re-enqueues with delay when attempts < max", () => {
      const job = repo.enqueue({ kind: "k", maxAttempts: 3 });
      repo.claimNextDue(new Date().toISOString(), "w", 60_000);

      repo.fail(job.id, "boom", 5_000);

      const after = repo.get(job.id);
      assert.ok(after);
      assert.equal(after.status, "pending");
      assert.equal(after.attempts, 1);
      assert.equal(after.lastError, "boom");
      assert.equal(after.leaseOwner, undefined);
      const nextMs = new Date(after.nextRunAt).getTime();
      assert.ok(nextMs > Date.now() - 1_000, "nextRunAt should be near future");
    });

    it("marks as failed when attempts >= max", () => {
      const job = repo.enqueue({ kind: "k", maxAttempts: 2 });
      repo.fail(job.id, "first");
      const mid = repo.get(job.id);
      assert.equal(mid?.status, "pending");
      assert.equal(mid?.attempts, 1);

      repo.fail(job.id, "second");
      const final = repo.get(job.id);
      assert.equal(final?.status, "failed");
      assert.equal(final?.attempts, 2);
      assert.equal(final?.lastError, "second");
    });
  });

  describe("releaseExpiredLeases", () => {
    const { db, repo, tmpDir } = setup();
    after(() => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("recovers stuck running jobs", () => {
      const fresh = setup();
      try {
        const job = fresh.repo.enqueue({ kind: "k", runAt: "2026-01-01T00:00:00.000Z" });
        const claimedAt = "2026-01-01T00:00:00.000Z";
        const claimed = fresh.repo.claimNextDue(claimedAt, "worker", 1_000);
        assert.ok(claimed);
        assert.equal(claimed.status, "running");

        const released = fresh.repo.releaseExpiredLeases("2026-01-01T00:01:00.000Z");
        assert.equal(released, 1);

        const after = fresh.repo.get(job.id);
        assert.equal(after?.status, "pending");
        assert.equal(after?.leaseOwner, undefined);
        assert.equal(after?.leaseExpiresAt, undefined);
      } finally {
        fresh.db.close();
        fs.rmSync(fresh.tmpDir, { recursive: true, force: true });
      }
    });

    it("does not release leases that haven't expired yet", () => {
      const fresh = setup();
      try {
        fresh.repo.enqueue({ kind: "k", runAt: "2026-02-01T00:00:00.000Z" });
        const claimedAt = "2026-02-01T00:00:00.000Z";
        const claimed = fresh.repo.claimNextDue(claimedAt, "worker", 60_000);
        assert.ok(claimed);

        const released = fresh.repo.releaseExpiredLeases("2026-02-01T00:00:30.000Z");
        assert.equal(released, 0);
      } finally {
        fresh.db.close();
        fs.rmSync(fresh.tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("succeed", () => {
    const { db, repo, tmpDir } = setup();
    after(() => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("marks job as succeeded and clears lease", () => {
      const job = repo.enqueue({ kind: "k" });
      repo.claimNextDue(new Date().toISOString(), "w", 60_000);
      repo.succeed(job.id);
      const after = repo.get(job.id);
      assert.equal(after?.status, "succeeded");
      assert.equal(after?.leaseOwner, undefined);
    });
  });
});
