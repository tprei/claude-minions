import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { AuditRepo } from "../../src/supervisor/audit-repo.js";
import type { AuditEvent } from "../../src/supervisor/alert.js";

function makeTempDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "audit-repo-test-"));
  const db = new Database(join(dir, "test.db"));
  return db;
}

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `ev-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    actor: "engine",
    action: "engine-lifecycle",
    ...overrides,
  };
}

describe("AuditRepo", () => {
  let db: Database.Database;
  let repo: AuditRepo;

  beforeEach(() => {
    db = makeTempDb();
    repo = new AuditRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts and lists an event", () => {
    const ev = makeEvent({ action: "engine-lifecycle", workflowId: "wf-1" });
    repo.insert(ev);
    const results = repo.list();
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(ev.id);
    expect(results[0]?.workflowId).toBe("wf-1");
  });

  it("list returns up to limit ordered by timestamp desc", () => {
    for (let i = 0; i < 5; i++) {
      repo.insert(makeEvent({ id: `ev-${i}`, timestamp: `2026-05-0${i + 1}T00:00:00.000Z` }));
    }
    const results = repo.list({ limit: 3 });
    expect(results).toHaveLength(3);
    const ts0 = results[0]?.timestamp ?? "";
    const ts1 = results[1]?.timestamp ?? "";
    expect(ts0 > ts1).toBe(true);
  });

  it("filters by action", () => {
    repo.insert(makeEvent({ action: "engine-lifecycle" }));
    repo.insert(makeEvent({ action: "alert" }));
    const results = repo.list({ action: "alert" });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("alert");
  });

  it("filters by workflowId", () => {
    repo.insert(makeEvent({ workflowId: "wf-a" }));
    repo.insert(makeEvent({ workflowId: "wf-b" }));
    const results = repo.list({ workflowId: "wf-a" });
    expect(results).toHaveLength(1);
    expect(results[0]?.workflowId).toBe("wf-a");
  });

  it("paginates with beforeTs", () => {
    repo.insert(makeEvent({ id: "ev-1", timestamp: "2026-05-01T00:00:00.000Z" }));
    repo.insert(makeEvent({ id: "ev-2", timestamp: "2026-05-02T00:00:00.000Z" }));
    repo.insert(makeEvent({ id: "ev-3", timestamp: "2026-05-03T00:00:00.000Z" }));
    const results = repo.list({ beforeTs: "2026-05-03T00:00:00.000Z" });
    expect(results.map((r) => r.id)).toContain("ev-1");
    expect(results.map((r) => r.id)).toContain("ev-2");
    expect(results.map((r) => r.id)).not.toContain("ev-3");
  });

  it("listByWorkflow only returns events for that workflow", () => {
    repo.insert(makeEvent({ workflowId: "wf-1" }));
    repo.insert(makeEvent({ workflowId: "wf-2" }));
    const results = repo.listByWorkflow("wf-1");
    expect(results).toHaveLength(1);
    expect(results[0]?.workflowId).toBe("wf-1");
  });

  it("preserves detail as JSON round-trip", () => {
    const ev = makeEvent({ detail: { sha: "abc123", error: "boom" } });
    repo.insert(ev);
    const results = repo.list();
    expect(results[0]?.detail).toEqual({ sha: "abc123", error: "boom" });
  });

  it("clamps limit to [1, 500]", () => {
    for (let i = 0; i < 10; i++) {
      repo.insert(makeEvent({ id: `ev-${i}` }));
    }
    const results = repo.list({ limit: 0 });
    expect(results).toHaveLength(1);
    const capped = repo.list({ limit: 9999 });
    expect(capped).toHaveLength(10);
  });
});
