import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { InMemorySubscriptionRepository } from "../../src/application/subscription-repository.js";
import { SQLiteSubscriptionRepository } from "../../src/persistence/sqlite-subscription-repo.js";
import type { PushSubscriptionRecord, SubscriptionRepository } from "../../src/application/subscription-repository.js";

function makeSub(endpoint: string, workflowId = "wf-1"): PushSubscriptionRecord {
  return { endpoint, workflowId, keys: { p256dh: `p256-${endpoint}`, auth: `auth-${endpoint}` } };
}

function sharedTests(makeRepo: () => SubscriptionRepository) {
  it("upserts and lists by workflow", async () => {
    const repo = makeRepo();
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-1"));
    await repo.upsert(makeSub("https://push.example.com/s2", "wf-1"));
    await repo.upsert(makeSub("https://push.example.com/s3", "wf-2"));

    const wf1Subs = await repo.listByWorkflow("wf-1");
    expect(wf1Subs).toHaveLength(2);
    expect(wf1Subs.map((s) => s.endpoint)).toContain("https://push.example.com/s1");
    expect(wf1Subs.map((s) => s.endpoint)).toContain("https://push.example.com/s2");

    const wf2Subs = await repo.listByWorkflow("wf-2");
    expect(wf2Subs).toHaveLength(1);
  });

  it("remove deletes subscription", async () => {
    const repo = makeRepo();
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-1"));
    await repo.remove("https://push.example.com/s1", "wf-1");
    const subs = await repo.listByWorkflow("wf-1");
    expect(subs).toHaveLength(0);
  });

  it("remove is scoped — only removes the matching endpoint+workflow pair", async () => {
    const repo = makeRepo();
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-1"));
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-2"));
    await repo.remove("https://push.example.com/s1", "wf-1");
    const wf1 = await repo.listByWorkflow("wf-1");
    const wf2 = await repo.listByWorkflow("wf-2");
    expect(wf1).toHaveLength(0);
    expect(wf2).toHaveLength(1);
  });

  it("remove is idempotent — no error on unknown endpoint+workflow pair", async () => {
    const repo = makeRepo();
    await expect(repo.remove("https://push.example.com/nonexistent", "wf-1")).resolves.toBeUndefined();
  });

  it("same endpoint subscribes to two workflows as two distinct rows", async () => {
    const repo = makeRepo();
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-1"));
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-2"));
    const wf1 = await repo.listByWorkflow("wf-1");
    const wf2 = await repo.listByWorkflow("wf-2");
    expect(wf1).toHaveLength(1);
    expect(wf2).toHaveLength(1);
  });

  it("listByWorkflow returns empty for unknown workflow", async () => {
    const repo = makeRepo();
    const subs = await repo.listByWorkflow("nonexistent");
    expect(subs).toHaveLength(0);
  });

  it("upsert updates keys for existing endpoint+workflow pair", async () => {
    const repo = makeRepo();
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-1"));
    await repo.upsert({ endpoint: "https://push.example.com/s1", workflowId: "wf-1", keys: { p256dh: "new-p256", auth: "new-auth" } });

    const wf1 = await repo.listByWorkflow("wf-1");
    expect(wf1).toHaveLength(1);
    expect(wf1[0]!.keys.p256dh).toBe("new-p256");
  });
}

describe("InMemorySubscriptionRepository", () => {
  sharedTests(() => new InMemorySubscriptionRepository());
});

describe("SQLiteSubscriptionRepository", () => {
  let db: Database.Database;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "sub-repo-test-"));
    db = new Database(join(dir, "test.db"));
  });

  afterEach(() => {
    db.close();
  });

  sharedTests(() => new SQLiteSubscriptionRepository(db));
});
