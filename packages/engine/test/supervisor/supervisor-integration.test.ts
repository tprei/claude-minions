import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/engine.js";
import type { Engine } from "../../src/engine.js";
import type { PushSender, PushSendResult } from "../../src/plugins/push-sender.js";

function makeTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-integration-test-"));
  return join(dir, "test.db");
}

const VAPID = {
  publicKey: "BM7BDuJKEkZLMBpLMNmNdK9oDBpU_6UwmBXjTQ0YSVKL1FJPGbXoP-MiQB4JFRZ5mJ65rqM0bkJbXHmUO4pMj0",
  privateKey: "test-private-key-for-integration",
  subject: "mailto:test@example.com",
};

class CapturingSender implements PushSender {
  readonly payloads: string[] = [];
  async send(_target: unknown, payload: string): Promise<PushSendResult> {
    this.payloads.push(payload);
    return { ok: true };
  }
}

describe("Supervisor integration", () => {
  let engine: Engine;
  let dbPath: string;
  let sender: CapturingSender;

  beforeEach(async () => {
    dbPath = makeTempDb();
    sender = new CapturingSender();
    engine = await createEngine({
      dbPath,
      vapid: VAPID,
      pushSender: sender,
      scanIntervalMs: 10_000,
      logSinks: [],
    });
  });

  afterEach(async () => {
    await engine.close();
  });

  it("engine starts and supervisor is wired (no crash)", () => {
    expect(engine).toBeDefined();
    expect(engine.server).toBeDefined();
  });

  it("audit route returns 200 with engine lifecycle events from boot", async () => {
    const res = await engine.server.request("/audit/events");
    expect(res.status).toBe(200);
    const body = await res.json() as { events: { action: string }[] };
    expect(Array.isArray(body.events)).toBe(true);
    const actions = body.events.map((e) => e.action);
    expect(actions).toContain("engine-lifecycle");
  });

  it("alerts route returns empty list initially", async () => {
    const res = await engine.server.request("/alerts");
    expect(res.status).toBe(200);
    const body = await res.json() as { alerts: unknown[] };
    expect(body.alerts).toEqual([]);
  });

  it("engine-lifecycle boot-complete log is projected to audit_events", async () => {
    const res = await engine.server.request("/audit/events?action=engine-lifecycle");
    const body = await res.json() as { events: { action: string; detail?: Record<string, unknown> }[] };
    const bootEvents = body.events.filter((e) => e.detail?.["phase"] === "boot-complete");
    expect(bootEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("alert subscription subscribe/unsubscribe roundtrip", async () => {
    const subPayload = {
      subscription: {
        endpoint: "https://push.example.com/alert-sub-1",
        keys: { p256dh: "key1", auth: "auth1" },
      },
    };
    const postRes = await engine.server.request("/alerts/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subPayload),
    });
    expect(postRes.status).toBe(201);

    const delRes = await engine.server.request("/alerts/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example.com/alert-sub-1" }),
    });
    expect(delRes.status).toBe(200);
  });
});
