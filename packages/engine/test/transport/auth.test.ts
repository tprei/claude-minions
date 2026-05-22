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
});
