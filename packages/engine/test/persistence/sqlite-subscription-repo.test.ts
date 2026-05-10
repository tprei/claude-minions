import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SQLiteSubscriptionRepository } from "../../src/persistence/sqlite-subscription-repo.js";
import type { PushSubscriptionRecord } from "../../src/application/subscription-repository.js";

function makeSub(endpoint: string, workflowId: string): PushSubscriptionRecord {
  return { endpoint, workflowId, keys: { p256dh: `p256-${endpoint}`, auth: `auth-${endpoint}` } };
}

describe("SQLiteSubscriptionRepository composite PK (HIGH 2)", () => {
  let db: Database.Database;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-sub-repo-test-"));
    db = new Database(join(dir, "test.db"));
  });

  afterEach(() => {
    db.close();
  });

  it("same endpoint subscribed to two workflows creates two distinct rows", async () => {
    const repo = new SQLiteSubscriptionRepository(db);
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-1"));
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-2"));

    const wf1 = await repo.listByWorkflow("wf-1");
    const wf2 = await repo.listByWorkflow("wf-2");
    expect(wf1).toHaveLength(1);
    expect(wf2).toHaveLength(1);
  });

  it("remove is scoped to endpoint+workflow — does not delete sibling workflow subscription", async () => {
    const repo = new SQLiteSubscriptionRepository(db);
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-1"));
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-2"));

    await repo.remove("https://push.example.com/s1", "wf-1");

    const wf1 = await repo.listByWorkflow("wf-1");
    const wf2 = await repo.listByWorkflow("wf-2");
    expect(wf1).toHaveLength(0);
    expect(wf2).toHaveLength(1);
  });

  it("upsert updates keys for existing endpoint+workflow pair without touching other pairs", async () => {
    const repo = new SQLiteSubscriptionRepository(db);
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-1"));
    await repo.upsert(makeSub("https://push.example.com/s1", "wf-2"));

    await repo.upsert({ endpoint: "https://push.example.com/s1", workflowId: "wf-1", keys: { p256dh: "new-key", auth: "new-auth" } });

    const wf1 = await repo.listByWorkflow("wf-1");
    const wf2 = await repo.listByWorkflow("wf-2");
    expect(wf1).toHaveLength(1);
    expect(wf1[0]!.keys.p256dh).toBe("new-key");
    expect(wf2).toHaveLength(1);
    expect(wf2[0]!.keys.p256dh).toBe(`p256-https://push.example.com/s1`);
  });
});
