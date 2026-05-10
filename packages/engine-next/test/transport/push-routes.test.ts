import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { InMemorySubscriptionRepository } from "../../src/application/subscription-repository.js";
import { NoopRestackExecutor } from "../../src/application/restack-executor.js";
import { createRecoveryService } from "../../src/application/recovery-service.js";
import { silentLogger } from "../test-helpers.js";
import { PushService } from "../../src/application/push-service.js";
import { StubPushSender } from "../../src/testing/stub-push-sender.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { createServer } from "../../src/transport/server.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";

const now = "2026-05-04T11:19:00.000Z";

function makeApp(withPush = true) {
  const repo = new InMemoryWorkflowRepository();
  const executor = new NoopRestackExecutor();
  const runtime = new StubRuntimeBackend();
  const recoveryService = createRecoveryService(repo, executor, runtime, () => now, silentLogger());

  if (!withPush) {
    return { app: createServer({ repo, recoveryService, executor }), repo };
  }

  const subscriptions = new InMemorySubscriptionRepository();
  const sender = new StubPushSender();
  const controller = new AbortController();
  const pushService = new PushService({ workflowRepo: repo, subscriptions, sender, signal: controller.signal, log: silentLogger() });

  const app = createServer({
    repo,
    recoveryService,
    executor,
    pushService,
    subscriptions,
    vapidPublicKey: "BCxyz_fake_public_key",
  });
  return { app, repo, subscriptions, pushService, sender, controller };
}

describe("GET /push/vapid-public-key", () => {
  it("returns 200 with public key when configured", async () => {
    const { app } = makeApp(true);
    const res = await app.request("/push/vapid-public-key");
    expect(res.status).toBe(200);
    const body = await res.json() as { publicKey: string };
    expect(body.publicKey).toBe("BCxyz_fake_public_key");
  });

  it("returns 503 when push not configured", async () => {
    const { app } = makeApp(false);
    const res = await app.request("/push/vapid-public-key");
    expect(res.status).toBe(503);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("push_disabled");
  });
});

describe("POST /push/subscribe", () => {
  it("returns 201 on valid subscription for known workflow", async () => {
    const { app, repo } = makeApp();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        subscription: {
          endpoint: "https://push.example.com/sub1",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("persists the subscription", async () => {
    const { app, repo, subscriptions } = makeApp() as ReturnType<typeof makeApp> & { subscriptions: InMemorySubscriptionRepository };
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        subscription: {
          endpoint: "https://push.example.com/sub1",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    const subs = await subscriptions.listByWorkflow("wf-1");
    expect(subs).toHaveLength(1);
    expect(subs[0]!.endpoint).toBe("https://push.example.com/sub1");
  });

  it("returns 400 when subscription.endpoint is missing", async () => {
    const { app, repo } = makeApp();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        subscription: { keys: { p256dh: "key1", auth: "auth1" } },
      }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when endpoint uses http:// with non-local host", async () => {
    const { app, repo } = makeApp();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        subscription: {
          endpoint: "http://push.example.com/sub1",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    expect(res.status).toBe(400);
  });

  it("accepts http://localhost endpoint", async () => {
    const { app, repo } = makeApp();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        subscription: {
          endpoint: "http://localhost/push",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    expect(res.status).toBe(201);
  });

  it("accepts http://127.0.0.1 endpoint", async () => {
    const { app, repo } = makeApp();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        subscription: {
          endpoint: "http://127.0.0.1/push",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    expect(res.status).toBe(201);
  });

  it("accepts http://[::1] endpoint", async () => {
    const { app, repo } = makeApp();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        subscription: {
          endpoint: "http://[::1]/push",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    expect(res.status).toBe(201);
  });

  it("rejects http://localhost.evil.com prefix-attack endpoint", async () => {
    const { app, repo } = makeApp();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        subscription: {
          endpoint: "http://localhost.evil.com/push",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects http://127.0.0.1.evil.com prefix-attack endpoint", async () => {
    const { app, repo } = makeApp();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        subscription: {
          endpoint: "http://127.0.0.1.evil.com/push",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects ftp://localhost endpoint (wrong scheme)", async () => {
    const { app, repo } = makeApp();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        subscription: {
          endpoint: "ftp://localhost/push",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects malformed URL endpoint", async () => {
    const { app, repo } = makeApp();
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        subscription: {
          endpoint: "not-a-url",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when workflowId is empty", async () => {
    const { app } = makeApp();

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "",
        subscription: {
          endpoint: "https://push.example.com/sub1",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown workflowId", async () => {
    const { app } = makeApp();

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "nonexistent",
        subscription: {
          endpoint: "https://push.example.com/sub1",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 503 when push not configured", async () => {
    const { app, repo } = makeApp(false);
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const res = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        subscription: {
          endpoint: "https://push.example.com/sub1",
          keys: { p256dh: "key1", auth: "auth1" },
        },
      }),
    });

    expect(res.status).toBe(503);
  });
});

describe("DELETE /push/subscribe", () => {
  it("returns 200 and removes subscription", async () => {
    const { app, repo, subscriptions } = makeApp() as ReturnType<typeof makeApp> & { subscriptions: InMemorySubscriptionRepository };
    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);
    await subscriptions.upsert({
      endpoint: "https://push.example.com/sub1",
      workflowId: "wf-1",
      keys: { p256dh: "key1", auth: "auth1" },
    });

    const res = await app.request("/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example.com/sub1", workflowId: "wf-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    const remaining = await subscriptions.listByWorkflow("wf-1");
    expect(remaining).toHaveLength(0);
  });

  it("returns 200 idempotently for nonexistent endpoint", async () => {
    const { app } = makeApp();

    const res = await app.request("/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example.com/nonexistent", workflowId: "wf-1" }),
    });

    expect(res.status).toBe(200);
  });

  it("returns 400 when endpoint is missing", async () => {
    const { app } = makeApp();

    const res = await app.request("/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when workflowId is missing", async () => {
    const { app } = makeApp();

    const res = await app.request("/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example.com/sub1" }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 503 when push not configured", async () => {
    const { app } = makeApp(false);

    const res = await app.request("/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example.com/sub1", workflowId: "wf-1" }),
    });

    expect(res.status).toBe(503);
  });
});

describe("CORS preflight", () => {
  it("OPTIONS includes DELETE in allowed methods", async () => {
    const { app } = makeApp();
    const res = await app.request("/push/subscribe", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    const allow = res.headers.get("Access-Control-Allow-Methods") ?? "";
    expect(allow).toContain("DELETE");
  });
});
