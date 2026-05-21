import { describe, expect, it, vi } from "vitest";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { silentLogger } from "../test-helpers.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { createServer } from "../../src/transport/server.js";

function makeApp() {
  const repo = new InMemoryWorkflowRepository();
  const executor = new NoopRestackExecutor();
  const runtime = new StubRuntimeBackend();
  const recoveryService = createRecoveryService(repo, executor, runtime, () => "2026-05-10T00:00:00.000Z", silentLogger());
  return createServer({ repo, recoveryService, executor });
}

describe("GET /health", () => {
  it("returns 200 with {status: ok}", async () => {
    const app = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("uses the doctor report when configured and maps non-ok status to 503", async () => {
    const repo = new InMemoryWorkflowRepository();
    const executor = new NoopRestackExecutor();
    const runtime = new StubRuntimeBackend();
    const recoveryService = createRecoveryService(repo, executor, runtime, () => "2026-05-10T00:00:00.000Z", silentLogger());
    const app = createServer({
      repo,
      recoveryService,
      executor,
      doctor: async () => ({
        status: "error",
        checkedAt: "2026-05-10T00:00:00.000Z",
        checks: [{ name: "disk-free", status: "error", checkedAt: "2026-05-10T00:00:00.000Z" }],
      }),
    });

    const res = await app.request("/health");
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string; checkedAt: string };
    expect(body).toEqual({
      status: "error",
      checkedAt: "2026-05-10T00:00:00.000Z",
    });
  });

  it("prefers the cheap health summary over doctor for /health", async () => {
    const repo = new InMemoryWorkflowRepository();
    const executor = new NoopRestackExecutor();
    const runtime = new StubRuntimeBackend();
    const recoveryService = createRecoveryService(repo, executor, runtime, () => "2026-05-10T00:00:00.000Z", silentLogger());
    const doctor = vi.fn(async () => ({
      status: "error" as const,
      checkedAt: "2026-05-10T00:00:00.000Z",
      checks: [{ name: "disk-free", status: "error" as const, checkedAt: "2026-05-10T00:00:00.000Z" }],
    }));
    const health = vi.fn(async () => ({
      status: "ok" as const,
      checkedAt: "2026-05-10T00:00:00.000Z",
    }));
    const app = createServer({
      repo,
      recoveryService,
      executor,
      doctor,
      health,
    });

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      checkedAt: "2026-05-10T00:00:00.000Z",
    });
    expect(health).toHaveBeenCalledOnce();
    expect(doctor).not.toHaveBeenCalled();
  });

  it("returns version metadata when configured", async () => {
    const repo = new InMemoryWorkflowRepository();
    const executor = new NoopRestackExecutor();
    const runtime = new StubRuntimeBackend();
    const recoveryService = createRecoveryService(repo, executor, runtime, () => "2026-05-10T00:00:00.000Z", silentLogger());
    const app = createServer({
      repo,
      recoveryService,
      executor,
      versionInfo: () => ({
        apiVersion: "workflow-v1",
        libraryVersion: "0.1.0",
        buildSha: "abc123",
        features: ["workflows"],
        featuresPending: [],
        provider: "stub",
        providers: ["claude-code", "codex", "pi", "stub"],
        repos: [],
        pluginSet: ["runtime:stub"],
        startedAt: "2026-05-10T00:00:00.000Z",
      }),
    });

    const res = await app.request("/version");
    expect(res.status).toBe(200);
    const body = await res.json() as { buildSha: string; features: string[]; providers: string[] };
    expect(body.buildSha).toBe("abc123");
    expect(body.features).toContain("workflows");
    expect(body.providers).toContain("pi");
  });

  it("returns doctor report and maps error status to 503", async () => {
    const repo = new InMemoryWorkflowRepository();
    const executor = new NoopRestackExecutor();
    const runtime = new StubRuntimeBackend();
    const recoveryService = createRecoveryService(repo, executor, runtime, () => "2026-05-10T00:00:00.000Z", silentLogger());
    const app = createServer({
      repo,
      recoveryService,
      executor,
      doctor: async () => ({
        status: "error",
        checkedAt: "2026-05-10T00:00:00.000Z",
        checks: [{ name: "sqlite-wal", status: "error", checkedAt: "2026-05-10T00:00:00.000Z" }],
      }),
    });

    const res = await app.request("/doctor");
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string; checks: Array<{ name: string }> };
    expect(body.status).toBe("error");
    expect(body.checks[0]?.name).toBe("sqlite-wal");
  });

  it("returns Prometheus metrics text", async () => {
    const repo = new InMemoryWorkflowRepository();
    const executor = new NoopRestackExecutor();
    const runtime = new StubRuntimeBackend();
    const recoveryService = createRecoveryService(repo, executor, runtime, () => "2026-05-10T00:00:00.000Z", silentLogger());
    const app = createServer({
      repo,
      recoveryService,
      executor,
      metrics: async () => "minions_test_metric 1\n",
    });

    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("minions_test_metric 1\n");
  });
});
