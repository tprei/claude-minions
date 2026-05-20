import { describe, expect, it } from "vitest";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { createServer } from "../../src/transport/server.js";
import { silentLogger } from "../test-helpers.js";

const now = "2026-05-17T00:00:00.000Z";

function makeApp() {
  const repo = new InMemoryWorkflowRepository();
  const executor = new NoopRestackExecutor();
  const runtime = new StubRuntimeBackend();
  const recoveryService = createRecoveryService(repo, executor, runtime, () => now, silentLogger());
  const app = createServer({
    repo,
    recoveryService,
    executor,
    authToken: "secret-token",
    corsOrigins: ["http://ui.example"],
  });
  return { app, repo };
}

describe("transport auth", () => {
  it("allows public health without a token", async () => {
    const { app } = makeApp();

    const res = await app.request("/health");

    expect(res.status).toBe(200);
  });

  it("rejects protected routes without a bearer token", async () => {
    const { app } = makeApp();

    const res = await app.request("/workflows");

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    const body = await res.json() as { code: string };
    expect(body.code).toBe("unauthorized");
  });

  it("accepts protected routes with the configured bearer token", async () => {
    const { app, repo } = makeApp();
    await repo.save(createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now), []);

    const res = await app.request("/workflows", {
      headers: { Authorization: "Bearer secret-token" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string }>;
    expect(body.map((workflow) => workflow.id)).toEqual(["wf-1"]);
  });

  it("includes Authorization in CORS preflight headers", async () => {
    const { app } = makeApp();

    const res = await app.request("/workflows", {
      method: "OPTIONS",
      headers: { Origin: "http://ui.example" },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://ui.example");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("accepts workflow SSE with an authorization header", async () => {
    const { app, repo } = makeApp();
    await repo.save(createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now), []);

    const res = await app.request("/workflows/wf-1/events?since=0", {
      headers: { Authorization: "Bearer secret-token" },
    });

    expect(res.status).toBe(200);
    await res.body?.cancel();
  });
});
