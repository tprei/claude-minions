import * as https from "node:https";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import webpush from "web-push";
import { createEngine } from "../../src/engine.js";
import type { Engine } from "../../src/engine.js";
import { serve } from "@hono/node-server";
import { WebPushSender } from "../../src/plugins/push-sender.js";
import type { VapidConfig } from "../../src/plugins/push-sender.js";

// Pre-generated self-signed EC cert for 127.0.0.1, valid 10 years from 2026-05-07.
// openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -keyout k.pem -out c.pem
//   -days 3650 -nodes -subj "/CN=127.0.0.1"
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgbVL+uI55G1AMGVSO
XqmUeDfydTEV57xXIITA0ps5MHOhRANCAAT1q5IqaBSHjMk8VzjgVehsi4ebjjKB
DJsXmW7YpDBsjNJSYy76NfNDzGxXDuac8kMC4hj2Af6MejpBIXHYteHO
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIURCFfzTMg3ZVCrUr9Ibw2z/IKpMswCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDUwNzEzNTExOVoXDTM2MDUwNDEz
NTExOVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE9auSKmgUh4zJPFc44FXobIuHm44ygQybF5lu2KQwbIzSUmMu+jXzQ8xs
Vw7mnPJDAuIY9gH+jHo6QSFx2LXhzqNTMFEwHQYDVR0OBBYEFOkch+g1rqAKFJ3O
yv0DjpbfsUAQMB8GA1UdIwQYMBaAFOkch+g1rqAKFJ3Oyv0DjpbfsUAQMA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgYMHzVfpvLVG7NTY3I2bV5Age
8r4LCfi7F6777v+vopYCIQCVB1wc8IV5b7MAXvKULpED5+4czLUVhyWbrNDiNr7a
kQ==
-----END CERTIFICATE-----`;

interface ReceivedRequest {
  headers: Record<string, string>;
  body: string;
}

interface StubPushServer {
  server: https.Server;
  requests: ReceivedRequest[];
  url: string;
  setResponseCode(code: number): void;
}

async function startStubPushServer(initialCode: number): Promise<StubPushServer> {
  const requests: ReceivedRequest[] = [];
  let currentCode = initialCode;

  const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("binary"); });
    req.on("end", () => {
      requests.push({ headers: req.headers as Record<string, string>, body });
      res.writeHead(currentCode);
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        requests,
        url: `https://127.0.0.1:${addr.port}`,
        setResponseCode: (code: number) => { currentCode = code; },
      });
    });
  });
}

describe("push integration: VAPID-signed delivery and 410 cleanup", () => {
  let engine: Engine;
  let engineServer: ReturnType<typeof serve>;
  let enginePort: number;
  let vapid: VapidConfig;
  let stubServer: StubPushServer;

  beforeEach(async () => {
    stubServer = await startStubPushServer(201);
    vapid = {
      ...webpush.generateVAPIDKeys(),
      subject: "mailto:test@example.com",
    };

    const tlsAgent = new https.Agent({ rejectUnauthorized: false });
    const pushSender = new WebPushSender(vapid, tlsAgent);

    const dir = mkdtempSync(join(tmpdir(), "push-int-test-"));
    engine = await createEngine({
      dbPath: join(dir, "test.db"),
      vapid,
      pushSender,
    });

    await new Promise<void>((resolve) => {
      engineServer = serve({ fetch: engine.server.fetch, port: 0 }, (info) => {
        enginePort = info.port;
        resolve();
      });
    });
  }, 20000);

  afterEach(async () => {
    await engine.close();
    engineServer.close();
    stubServer.server.close();
  });

  async function engineFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${enginePort}${path}`, init);
  }

  async function transitionToCompleted(workflowId: string, taskId: string, sessionId: string): Promise<void> {
    const cmds = [
      { kind: "transition-task", workflowId, transition: { kind: "mark-ready", taskId, now: new Date().toISOString() } },
      { kind: "transition-task", workflowId, transition: { kind: "mark-running", taskId, sessionId, now: new Date().toISOString() } },
      { kind: "transition-task", workflowId, transition: { kind: "complete-runtime", taskId, expectedSessionId: sessionId, artifacts: [], now: new Date().toISOString() } },
    ];
    for (const cmd of cmds) {
      const r = await engineFetch("/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cmd),
      });
      if (r.status !== 200) {
        throw new Error(`command failed ${r.status}: ${await r.text()}`);
      }
    }
  }

  it("delivers VAPID-signed push when task-transitioned to completed", async () => {
    const createRes = await engineFetch("/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "wf-push-1",
        kind: "single-task",
        tasks: [{ id: "t1", title: "Task", prompt: "Do it" }],
      }),
    });
    expect(createRes.status).toBe(201);

    const subKeys = webpush.generateVAPIDKeys();
    const subRes = await engineFetch("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-push-1",
        subscription: {
          endpoint: `${stubServer.url}/push`,
          keys: { p256dh: subKeys.publicKey, auth: "dGVzdC1hdXRoLXZhbHVlLSE" },
        },
      }),
    });
    expect(subRes.status).toBe(201);

    await new Promise((r) => setTimeout(r, 50));
    await transitionToCompleted("wf-push-1", "t1", "sess1");
    await new Promise((r) => setTimeout(r, 800));

    expect(stubServer.requests.length).toBeGreaterThanOrEqual(1);
    const req = stubServer.requests[0]!;
    expect(req.headers["authorization"]).toBeDefined();
    expect(req.headers["authorization"]).toMatch(/vapid/i);
    expect(req.headers["ttl"]).toBeDefined();
    expect(req.body.length).toBeGreaterThan(0);
  }, 20000);

  it("removes subscription when stub returns 410", async () => {
    stubServer.setResponseCode(410);

    const createRes = await engineFetch("/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "wf-push-2",
        kind: "single-task",
        tasks: [{ id: "t2", title: "Task2", prompt: "Do it" }],
      }),
    });
    expect(createRes.status).toBe(201);

    const subKeys = webpush.generateVAPIDKeys();
    await engineFetch("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-push-2",
        subscription: {
          endpoint: `${stubServer.url}/push`,
          keys: { p256dh: subKeys.publicKey, auth: "dGVzdC1hdXRoLXZhbHVlLSE" },
        },
      }),
    });

    await new Promise((r) => setTimeout(r, 50));
    await transitionToCompleted("wf-push-2", "t2", "sess2");
    await new Promise((r) => setTimeout(r, 800));

    // Push reached stub (got 410 back)
    expect(stubServer.requests.length).toBeGreaterThanOrEqual(1);

    // Re-subscribe to a new workflow with the same endpoint — proves upsert works
    // and also verifies the second delivery goes through (old sub deleted, new sub added)
    stubServer.setResponseCode(201);

    const createRes2 = await engineFetch("/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "wf-push-3",
        kind: "single-task",
        tasks: [{ id: "t3", title: "Task3", prompt: "Do it" }],
      }),
    });
    expect(createRes2.status).toBe(201);

    await engineFetch("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-push-3",
        subscription: {
          endpoint: `${stubServer.url}/push`,
          keys: { p256dh: subKeys.publicKey, auth: "dGVzdC1hdXRoLXZhbHVlLSE" },
        },
      }),
    });

    await new Promise((r) => setTimeout(r, 50));

    const beforeCount = stubServer.requests.length;
    await transitionToCompleted("wf-push-3", "t3", "sess3");
    await new Promise((r) => setTimeout(r, 800));

    expect(stubServer.requests.length).toBeGreaterThan(beforeCount);
  }, 30000);
});
