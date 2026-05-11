import { describe, expect, it } from "vitest";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { silentLogger } from "../test-helpers.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { createServer } from "../../src/transport/server.js";

const now = "2026-05-04T11:19:00.000Z";

function makeApp(pwaRoot?: string) {
  const repo = new InMemoryWorkflowRepository();
  const executor = new NoopRestackExecutor();
  const runtime = new StubRuntimeBackend();
  const recoveryService = createRecoveryService(repo, executor, runtime, () => now, silentLogger());
  const app = createServer({
    repo,
    recoveryService,
    executor,
    ...(pwaRoot !== undefined ? { pwaRoot } : {}),
  });
  return app;
}

describe("static serving with pwaRoot set", () => {
  const pwaRoot = "test/fixtures/pwa-stub";

  it("GET / returns 200 with text/html content type", async () => {
    const app = makeApp(pwaRoot);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toMatch(/text\/html/);
  });

  it("GET / response body contains the fixture banner", async () => {
    const app = makeApp(pwaRoot);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("TEST FIXTURE — slice 16 pwa-stub");
  });

  it("GET /manifest.json returns 200 with parseable JSON", async () => {
    const app = makeApp(pwaRoot);
    const res = await app.request("/manifest.json");
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string };
    expect(body.name).toBe("TEST FIXTURE — slice 16 pwa-stub");
  });

  it("GET / includes Cache-Control: no-cache header", async () => {
    const app = makeApp(pwaRoot);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("GET /sw.js returns 200", async () => {
    const app = makeApp(pwaRoot);
    const res = await app.request("/sw.js");
    expect(res.status).toBe(200);
  });

  it("GET /sw.js includes Cache-Control: no-cache header", async () => {
    const app = makeApp(pwaRoot);
    const res = await app.request("/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("GET /icons/icon-192.png returns 200", async () => {
    const app = makeApp(pwaRoot);
    const res = await app.request("/icons/icon-192.png");
    expect(res.status).toBe(200);
  });

  it("GET /assets/app-v1.js returns 200", async () => {
    const app = makeApp(pwaRoot);
    const res = await app.request("/assets/app-v1.js");
    expect(res.status).toBe(200);
  });
});

describe("static serving without pwaRoot", () => {
  it("GET / returns 404", async () => {
    const app = makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(404);
  });

  it("GET /manifest.json returns 404", async () => {
    const app = makeApp();
    const res = await app.request("/manifest.json");
    expect(res.status).toBe(404);
  });
});

describe("static serving with pwaRoot set but no sw.js in fixture", () => {
  const pwaRoot = "test/fixtures/pwa-no-sw-stub";

  it("GET /sw.js returns 404 when sw.js is absent from fixture", async () => {
    const app = makeApp(pwaRoot);
    const res = await app.request("/sw.js");
    expect(res.status).toBe(404);
  });
});
