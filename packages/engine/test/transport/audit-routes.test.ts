import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createServer } from "../../src/transport/server.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { createSupervisor } from "../../src/supervisor/supervisor.js";
import type { SupervisorWithRepos } from "../../src/supervisor/supervisor.js";
import type { Alert } from "../../src/supervisor/alert.js";
import type { AuditEvent } from "../../src/supervisor/alert.js";
import { createLogger } from "../../src/observability/logger.js";
import type { Hono } from "hono";

function makeTempDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "audit-routes-test-"));
  return new Database(join(dir, "test.db"));
}

const nullLog = createLogger("error", []);

function makeAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `ev-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    actor: "engine",
    action: "engine-lifecycle",
    ...overrides,
  };
}

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: `al-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    kind: "merge-inconsistent",
    severity: "error",
    message: "test",
    ...overrides,
  };
}

describe("Audit + Alert HTTP routes", () => {
  let db: Database.Database;
  let supervisor: SupervisorWithRepos;
  let app: Hono;
  let repo: InMemoryWorkflowRepository;

  beforeEach(() => {
    db = makeTempDb();
    supervisor = createSupervisor({ db });
    repo = new InMemoryWorkflowRepository();
    const recoveryService = createRecoveryService(
      repo,
      new NoopRestackExecutor(),
      new StubRuntimeBackend(),
      () => new Date().toISOString(),
      nullLog,
    );
    app = createServer({ repo, recoveryService, executor: new NoopRestackExecutor(), supervisor });
  });

  afterEach(() => {
    db.close();
  });

  describe("GET /audit/events", () => {
    it("returns empty list when no events", async () => {
      const res = await app.request("/audit/events");
      expect(res.status).toBe(200);
      const body = await res.json() as { events: unknown[] };
      expect(body.events).toEqual([]);
    });

    it("returns inserted audit events", async () => {
      supervisor.auditRepo.insert(makeAuditEvent({ action: "engine-lifecycle" }));
      supervisor.auditRepo.insert(makeAuditEvent({ action: "alert" }));
      const res = await app.request("/audit/events");
      const body = await res.json() as { events: AuditEvent[] };
      expect(body.events).toHaveLength(2);
    });

    it("filters by action", async () => {
      supervisor.auditRepo.insert(makeAuditEvent({ action: "engine-lifecycle" }));
      supervisor.auditRepo.insert(makeAuditEvent({ action: "alert" }));
      const res = await app.request("/audit/events?action=alert");
      const body = await res.json() as { events: AuditEvent[] };
      expect(body.events).toHaveLength(1);
      expect(body.events[0]?.action).toBe("alert");
    });

    it("filters by workflowId", async () => {
      supervisor.auditRepo.insert(makeAuditEvent({ workflowId: "wf-1" }));
      supervisor.auditRepo.insert(makeAuditEvent({ workflowId: "wf-2" }));
      const res = await app.request("/audit/events?workflowId=wf-1");
      const body = await res.json() as { events: AuditEvent[] };
      expect(body.events).toHaveLength(1);
      expect(body.events[0]?.workflowId).toBe("wf-1");
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) supervisor.auditRepo.insert(makeAuditEvent());
      const res = await app.request("/audit/events?limit=2");
      const body = await res.json() as { events: AuditEvent[] };
      expect(body.events).toHaveLength(2);
    });

    it("503 when supervisor is not configured", async () => {
      const appNoSup = createServer({ repo, recoveryService: createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => new Date().toISOString(), nullLog), executor: new NoopRestackExecutor() });
      const res = await appNoSup.request("/audit/events");
      expect(res.status).toBe(503);
      const body = await res.json() as { code: string };
      expect(body.code).toBe("supervisor_disabled");
    });
  });

  describe("GET /audit/workflows/:id", () => {
    it("returns events for specific workflow", async () => {
      supervisor.auditRepo.insert(makeAuditEvent({ workflowId: "wf-target" }));
      supervisor.auditRepo.insert(makeAuditEvent({ workflowId: "wf-other" }));
      const res = await app.request("/audit/workflows/wf-target");
      const body = await res.json() as { events: AuditEvent[] };
      expect(body.events).toHaveLength(1);
      expect(body.events[0]?.workflowId).toBe("wf-target");
    });

    it("503 when supervisor is not configured", async () => {
      const appNoSup = createServer({ repo, recoveryService: createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => new Date().toISOString(), nullLog), executor: new NoopRestackExecutor() });
      const res = await appNoSup.request("/audit/workflows/wf-1");
      expect(res.status).toBe(503);
    });
  });

  describe("GET /alerts", () => {
    it("returns empty list when no alerts", async () => {
      const res = await app.request("/alerts");
      expect(res.status).toBe(200);
      const body = await res.json() as { alerts: unknown[] };
      expect(body.alerts).toEqual([]);
    });

    it("returns inserted alerts", async () => {
      supervisor.alertRepo.insert(makeAlert());
      const res = await app.request("/alerts");
      const body = await res.json() as { alerts: Alert[] };
      expect(body.alerts).toHaveLength(1);
    });

    it("503 when supervisor is not configured", async () => {
      const appNoSup = createServer({ repo, recoveryService: createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => new Date().toISOString(), nullLog), executor: new NoopRestackExecutor() });
      const res = await appNoSup.request("/alerts");
      expect(res.status).toBe(503);
    });
  });

  describe("POST /alerts/subscribe", () => {
    it("subscribes and returns 201", async () => {
      const res = await app.request("/alerts/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: {
            endpoint: "https://push.example.com/1",
            keys: { p256dh: "key1", auth: "auth1" },
          },
        }),
      });
      expect(res.status).toBe(201);
      expect(supervisor.subRepo.list()).toHaveLength(1);
    });

    it("returns 400 for invalid body", async () => {
      const res = await app.request("/alerts/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: { endpoint: "" } }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { code: string };
      expect(body.code).toBe("invalid_request");
    });

    it("503 when supervisor is not configured", async () => {
      const appNoSup = createServer({ repo, recoveryService: createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => new Date().toISOString(), nullLog), executor: new NoopRestackExecutor() });
      const res = await appNoSup.request("/alerts/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(503);
    });
  });

  describe("DELETE /alerts/subscribe", () => {
    it("unsubscribes and returns 200", async () => {
      supervisor.subRepo.upsert({ endpoint: "https://push.example.com/1", keys: { p256dh: "k", auth: "a" } });
      const res = await app.request("/alerts/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "https://push.example.com/1" }),
      });
      expect(res.status).toBe(200);
      expect(supervisor.subRepo.list()).toHaveLength(0);
    });

    it("returns 400 for missing endpoint", async () => {
      const res = await app.request("/alerts/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("503 when supervisor is not configured", async () => {
      const appNoSup = createServer({ repo, recoveryService: createRecoveryService(repo, new NoopRestackExecutor(), new StubRuntimeBackend(), () => new Date().toISOString(), nullLog), executor: new NoopRestackExecutor() });
      const res = await appNoSup.request("/alerts/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "https://push.example.com/1" }),
      });
      expect(res.status).toBe(503);
    });
  });
});
