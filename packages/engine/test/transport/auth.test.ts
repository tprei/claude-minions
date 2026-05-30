import { describe, expect, it } from "vitest";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { silentLogger } from "../test-helpers.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { createServer } from "../../src/transport/server.js";

const now = "2026-05-04T11:19:00.000Z";

function makeApp() {
  const repo = new InMemoryWorkflowRepository();
  const executor = new NoopRestackExecutor();
  const runtime = new StubRuntimeBackend();
  const recoveryService = createRecoveryService(repo, executor, runtime, () => now, silentLogger());
  return createServer({ repo, recoveryService, executor, authToken: "secret-token", pwaRoot: "test/fixtures/pwa-stub" });
}

function makeGatedApp() {
  const repo = new InMemoryWorkflowRepository();
  const executor = new NoopRestackExecutor();
  const runtime = new StubRuntimeBackend();
  const recoveryService = createRecoveryService(repo, executor, runtime, () => now, silentLogger());
  return createServer({
    repo,
    recoveryService,
    executor,
    authToken: "secret-token",
    siteTokenAuth: true,
    pwaRoot: "test/fixtures/pwa-stub",
  });
}

describe("bearer auth", () => {
  it("leaves health and PWA routes public", async () => {
    const app = makeApp();

    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/c/conn/dag/task?dag=wf-1")).status).toBe(200);
  });

  it("rejects protected API routes without a bearer token", async () => {
    const app = makeApp();

    const res = await app.request("/workflows");
    expect(res.status).toBe(401);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("unauthorized");
  });

  it("accepts protected API routes with the configured bearer token", async () => {
    const app = makeApp();

    const res = await app.request("/workflows", {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(res.status).toBe(200);
  });

  it("accepts SSE auth through token query parameter", async () => {
    const app = makeApp();

    const res = await app.request("/workflows/missing/events?token=secret-token");
    expect(res.status).toBe(404);
  });

  it("does not accept token query parameter on non-SSE API routes", async () => {
    const app = makeApp();

    const res = await app.request("/workflows?token=secret-token");
    expect(res.status).toBe(401);
  });

  it("rejects token query parameter on /audit/events (not the SSE route)", async () => {
    const app = makeApp();

    const res = await app.request("/audit/events?token=secret-token");
    expect(res.status).toBe(401);
  });

  it("accepts token query parameter only on the /workflows/:id/events SSE route", async () => {
    const app = makeApp();

    const res = await app.request("/workflows/missing-wf/events?token=secret-token");
    expect(res.status).toBe(404);
  });
});

describe("site token gate", () => {
  it("leaves health public when site token auth is enabled", async () => {
    const app = makeGatedApp();

    expect((await app.request("/health")).status).toBe(200);
  });

  it("gates PWA routes behind the shared token", async () => {
    const app = makeGatedApp();

    const res = await app.request("/c/conn/dag/task?dag=wf-1");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Shared token required");
  });

  it("sets a cookie after a successful token form post", async () => {
    const app = makeGatedApp();

    const res = await app.request("/access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=secret-token&next=%2Fc%2Fconn%2Fdag%2Ftask%3Fdag%3Dwf-1",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/c/conn/dag/task?dag=wf-1");
    expect(res.headers.get("set-cookie")).toContain("mwf_access=secret-token");
  });

  it("allows PWA routes with the access cookie", async () => {
    const app = makeGatedApp();

    const res = await app.request("/c/conn/dag/task?dag=wf-1", {
      headers: { Cookie: "mwf_access=secret-token" },
    });
    expect(res.status).toBe(200);
  });

  it("accepts protected API routes with the access cookie", async () => {
    const app = makeGatedApp();

    const res = await app.request("/workflows", {
      headers: { Cookie: "mwf_access=secret-token" },
    });
    expect(res.status).toBe(200);
  });
});
