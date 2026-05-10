import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { AuditRepo } from "../../src/supervisor/audit-repo.js";
import { AuditProjector } from "../../src/supervisor/audit-projector.js";
import type { LogRecord } from "../../src/observability/types.js";

function makeTempDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "projector-test-"));
  return new Database(join(dir, "test.db"));
}

function makeRecord(overrides: Partial<LogRecord> & { kind?: string } = {}): LogRecord {
  return {
    t: new Date().toISOString(),
    lvl: "info",
    msg: "test",
    ...overrides,
  };
}

describe("AuditProjector", () => {
  let db: Database.Database;
  let auditRepo: AuditRepo;
  let projector: AuditProjector;

  beforeEach(() => {
    db = makeTempDb();
    auditRepo = new AuditRepo(db);
    projector = new AuditProjector(auditRepo);
  });

  afterEach(() => {
    db.close();
  });

  it("projects an allowlisted kind record", () => {
    projector.project(makeRecord({ kind: "engine-lifecycle", phase: "started" }));
    const events = auditRepo.list();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("engine-lifecycle");
  });

  it("drops records without a kind field", () => {
    projector.project(makeRecord({ msg: "no kind here" }));
    expect(auditRepo.list()).toHaveLength(0);
  });

  it("drops records with a non-allowlisted kind", () => {
    projector.project(makeRecord({ kind: "http-request" }));
    expect(auditRepo.list()).toHaveLength(0);
  });

  it("sets actor from component binding", () => {
    projector.project(makeRecord({ kind: "engine-lifecycle", component: "merge" }));
    const events = auditRepo.list();
    expect(events[0]?.actor).toBe("merge");
  });

  it("falls back to 'engine' actor when component is absent", () => {
    projector.project(makeRecord({ kind: "engine-lifecycle" }));
    const events = auditRepo.list();
    expect(events[0]?.actor).toBe("engine");
  });

  it("extracts workflowId and taskId", () => {
    projector.project(makeRecord({ kind: "alert", workflowId: "wf-1", taskId: "t-1" }));
    const events = auditRepo.list();
    expect(events[0]?.workflowId).toBe("wf-1");
    expect(events[0]?.taskId).toBe("t-1");
  });

  it("extracts detail fields excluding standard fields", () => {
    projector.project(makeRecord({ kind: "engine-lifecycle", phase: "started", dbPath: "/tmp/test.db" }));
    const events = auditRepo.list();
    expect(events[0]?.detail).toMatchObject({ phase: "started", dbPath: "/tmp/test.db" });
    expect(events[0]?.detail).not.toHaveProperty("t");
    expect(events[0]?.detail).not.toHaveProperty("lvl");
    expect(events[0]?.detail).not.toHaveProperty("msg");
    expect(events[0]?.detail).not.toHaveProperty("kind");
  });

  it("projects merge-inconsistent kind", () => {
    projector.project(makeRecord({ kind: "merge-inconsistent", workflowId: "wf-1" }));
    expect(auditRepo.list()).toHaveLength(1);
  });

  it("projects push-send-failed kind", () => {
    projector.project(makeRecord({ kind: "push-send-failed" }));
    expect(auditRepo.list()).toHaveLength(1);
  });

  it("projects ci-attempt-cap kind", () => {
    projector.project(makeRecord({ kind: "ci-attempt-cap", taskId: "t-1" }));
    expect(auditRepo.list()).toHaveLength(1);
  });

  it("projects alert kind", () => {
    projector.project(makeRecord({ kind: "alert", alertKind: "merge-inconsistent" }));
    expect(auditRepo.list()).toHaveLength(1);
  });

  it("inserts a unique id for each projection", () => {
    projector.project(makeRecord({ kind: "engine-lifecycle" }));
    projector.project(makeRecord({ kind: "engine-lifecycle" }));
    const events = auditRepo.list();
    expect(events).toHaveLength(2);
    expect(events[0]?.id).not.toBe(events[1]?.id);
  });
});
