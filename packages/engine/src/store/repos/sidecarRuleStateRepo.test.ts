import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { openStore } from "../sqlite.js";
import { createLogger } from "../../logger.js";
import { SidecarRuleStateRepo } from "./sidecarRuleStateRepo.js";

function setup(): { db: Database.Database; repo: SidecarRuleStateRepo; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-sidecar-rule-"));
  const dbPath = path.join(tmpDir, "test.db");
  const log = createLogger("error");
  const db = openStore({ path: dbPath, log });
  const repo = new SidecarRuleStateRepo(db);
  return { db, repo, tmpDir };
}

describe("SidecarRuleStateRepo", () => {
  describe("touchObserved", () => {
    it("returns changed=true on first observation and persists the hash", () => {
      const { db, repo, tmpDir } = setup();
      try {
        const result = repo.touchObserved("rule-a", "session", "sess-1", "hash-1");
        assert.equal(result.changed, true);
        assert.equal(result.attempts, 0);

        const stored = repo.get("rule-a", "session", "sess-1");
        assert.ok(stored);
        assert.equal(stored.lastInputHash, "hash-1");
      } finally {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns changed=true when input hash differs", () => {
      const { db, repo, tmpDir } = setup();
      try {
        repo.touchObserved("rule-a", "session", "sess-1", "hash-1");
        const result = repo.touchObserved("rule-a", "session", "sess-1", "hash-2");
        assert.equal(result.changed, true);

        const stored = repo.get("rule-a", "session", "sess-1");
        assert.equal(stored?.lastInputHash, "hash-2");
      } finally {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns changed=false with same input + cooldown active", () => {
      const { db, repo, tmpDir } = setup();
      try {
        repo.touchObserved("rule-a", "session", "sess-1", "hash-1");
        repo.recordAction("rule-a", "session", "sess-1", "poke", 60_000);

        const result = repo.touchObserved("rule-a", "session", "sess-1", "hash-1");
        assert.equal(result.changed, false);
        assert.equal(result.attempts, 1);
      } finally {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns changed=true with same input + cooldown expired", () => {
      const { db, repo, tmpDir } = setup();
      try {
        repo.touchObserved("rule-a", "session", "sess-1", "hash-1");
        repo.recordAction("rule-a", "session", "sess-1", "poke", 60_000);

        repo.set({
          ruleId: "rule-a",
          targetKind: "session",
          targetId: "sess-1",
          lastAction: "poke",
          attempts: 1,
          cooldownExpiresAt: "2020-01-01T00:00:00.000Z",
          lastInputHash: "hash-1",
          lastObservedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        });

        const result = repo.touchObserved("rule-a", "session", "sess-1", "hash-1");
        assert.equal(result.changed, true);
        assert.equal(result.attempts, 1);

        const stored = repo.get("rule-a", "session", "sess-1");
        assert.equal(stored?.cooldownExpiresAt, undefined);
      } finally {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("recordAction", () => {
    it("increments attempts and sets cooldown", () => {
      const { db, repo, tmpDir } = setup();
      try {
        repo.touchObserved("rule-a", "session", "sess-1", "hash-1");
        repo.recordAction("rule-a", "session", "sess-1", "spawn-fix", 30_000);

        const stored = repo.get("rule-a", "session", "sess-1");
        assert.ok(stored);
        assert.equal(stored.lastAction, "spawn-fix");
        assert.equal(stored.attempts, 1);
        assert.ok(stored.cooldownExpiresAt);
        const cooldownMs = new Date(stored.cooldownExpiresAt).getTime();
        assert.ok(cooldownMs > Date.now() - 1_000);

        repo.recordAction("rule-a", "session", "sess-1", "spawn-fix", 30_000);
        const after = repo.get("rule-a", "session", "sess-1");
        assert.equal(after?.attempts, 2);
      } finally {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("clearExpiredCooldowns", () => {
    it("drops rows whose cooldown has expired", () => {
      const { db, repo, tmpDir } = setup();
      try {
        repo.set({
          ruleId: "expired",
          targetKind: "session",
          targetId: "s1",
          attempts: 1,
          cooldownExpiresAt: "2020-01-01T00:00:00.000Z",
          lastObservedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        });
        repo.set({
          ruleId: "active",
          targetKind: "session",
          targetId: "s2",
          attempts: 1,
          cooldownExpiresAt: "2999-01-01T00:00:00.000Z",
          lastObservedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        });
        repo.set({
          ruleId: "no-cooldown",
          targetKind: "session",
          targetId: "s3",
          attempts: 0,
          lastObservedAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        });

        const removed = repo.clearExpiredCooldowns("2026-01-01T00:00:00.000Z");
        assert.equal(removed, 1);

        assert.equal(repo.get("expired", "session", "s1"), null);
        assert.ok(repo.get("active", "session", "s2"));
        assert.ok(repo.get("no-cooldown", "session", "s3"));
      } finally {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
