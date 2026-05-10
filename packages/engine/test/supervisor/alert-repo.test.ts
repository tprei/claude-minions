import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { AlertRepo, AlertSubscriptionRepo } from "../../src/supervisor/alert-repo.js";
import type { Alert, AlertSubscription } from "../../src/supervisor/alert.js";

function makeTempDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "alert-repo-test-"));
  return new Database(join(dir, "test.db"));
}

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: `al-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    kind: "merge-inconsistent",
    severity: "error",
    message: "test alert",
    ...overrides,
  };
}

describe("AlertRepo", () => {
  let db: Database.Database;
  let repo: AlertRepo;

  beforeEach(() => {
    db = makeTempDb();
    repo = new AlertRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts and lists an alert", () => {
    const alert = makeAlert({ workflowId: "wf-1", taskId: "t-1" });
    repo.insert(alert);
    const results = repo.list();
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(alert.id);
    expect(results[0]?.workflowId).toBe("wf-1");
    expect(results[0]?.taskId).toBe("t-1");
  });

  it("lists in descending timestamp order", () => {
    repo.insert(makeAlert({ id: "al-1", timestamp: "2026-05-01T00:00:00.000Z" }));
    repo.insert(makeAlert({ id: "al-2", timestamp: "2026-05-02T00:00:00.000Z" }));
    const results = repo.list();
    expect(results[0]?.id).toBe("al-2");
    expect(results[1]?.id).toBe("al-1");
  });

  it("paginates with beforeTs", () => {
    repo.insert(makeAlert({ id: "al-1", timestamp: "2026-05-01T00:00:00.000Z" }));
    repo.insert(makeAlert({ id: "al-2", timestamp: "2026-05-03T00:00:00.000Z" }));
    const results = repo.list({ beforeTs: "2026-05-03T00:00:00.000Z" });
    expect(results.map((r) => r.id)).toContain("al-1");
    expect(results.map((r) => r.id)).not.toContain("al-2");
  });

  it("preserves detail as JSON round-trip", () => {
    const alert = makeAlert({ detail: { count: 7 } });
    repo.insert(alert);
    const results = repo.list();
    expect(results[0]?.detail).toEqual({ count: 7 });
  });

  it("clamps limit to [1, 500]", () => {
    for (let i = 0; i < 5; i++) repo.insert(makeAlert({ id: `al-${i}` }));
    expect(repo.list({ limit: 0 })).toHaveLength(1);
    expect(repo.list({ limit: 9999 })).toHaveLength(5);
  });
});

describe("AlertSubscriptionRepo", () => {
  let db: Database.Database;
  let repo: AlertSubscriptionRepo;

  beforeEach(() => {
    db = makeTempDb();
    repo = new AlertSubscriptionRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  const sub1: AlertSubscription = {
    endpoint: "https://example.com/push/1",
    keys: { p256dh: "key1", auth: "auth1" },
  };

  const sub2: AlertSubscription = {
    endpoint: "https://example.com/push/2",
    keys: { p256dh: "key2", auth: "auth2" },
  };

  it("upserts and lists subscriptions", () => {
    repo.upsert(sub1);
    repo.upsert(sub2);
    const results = repo.list();
    expect(results).toHaveLength(2);
    const endpoints = results.map((r) => r.endpoint);
    expect(endpoints).toContain(sub1.endpoint);
    expect(endpoints).toContain(sub2.endpoint);
  });

  it("upsert is idempotent - updates keys on conflict", () => {
    repo.upsert(sub1);
    const updated: AlertSubscription = {
      endpoint: sub1.endpoint,
      keys: { p256dh: "new-key", auth: "new-auth" },
    };
    repo.upsert(updated);
    const results = repo.list();
    expect(results).toHaveLength(1);
    expect(results[0]?.keys.p256dh).toBe("new-key");
  });

  it("removes a subscription by endpoint", () => {
    repo.upsert(sub1);
    repo.upsert(sub2);
    repo.remove(sub1.endpoint);
    const results = repo.list();
    expect(results).toHaveLength(1);
    expect(results[0]?.endpoint).toBe(sub2.endpoint);
  });

  it("remove is a no-op for unknown endpoint", () => {
    repo.upsert(sub1);
    repo.remove("https://unknown.example.com/push");
    expect(repo.list()).toHaveLength(1);
  });
});
