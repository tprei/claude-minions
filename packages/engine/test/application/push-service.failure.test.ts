import { describe, expect, it } from "vitest";
import { PushService } from "../../src/application/push-service.js";
import { silentLogger } from "../test-helpers.js";
import { createLogger } from "../../src/observability/logger.js";
import type { Sink } from "../../src/observability/sinks.js";
import type { LogRecord } from "../../src/observability/types.js";

function makeCapturingSink(): { sink: Sink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: { write: (r) => { records.push(r); } }, records };
}
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { InMemorySubscriptionRepository } from "../../src/application/subscription-repository.js";
import { StubPushSender } from "../../src/testing/stub-push-sender.js";
import type { PushSubscriptionRecord } from "../../src/application/subscription-repository.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import type { WorkflowEvent } from "../../src/domain/events.js";

const nowStr = "2026-05-04T11:19:00.000Z";
const now = () => nowStr;

function makeSub(endpoint = "https://push.example.com/sub1"): PushSubscriptionRecord {
  return { endpoint, workflowId: "wf-1", keys: { p256dh: "key1", auth: "auth1" } };
}

function terminalEvent(): WorkflowEvent {
  return {
    cursor: 0,
    workflowId: "wf-1",
    occurredAt: nowStr,
    kind: "task-transitioned",
    payload: {
      taskId: "wf-1:task",
      fromExecutionStatus: "running",
      toExecutionStatus: "completed",
      fromStackStatus: "clean",
      toStackStatus: "clean",
      taskVersion: 2,
    },
  };
}

describe("PushService.trySend failure handling", () => {
  it("removes subscription on 410", async () => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const subscriptions = new InMemorySubscriptionRepository();
    const sender = new StubPushSender();
    const controller = new AbortController();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, now);
    await workflowRepo.save(wf, []);

    const sub = makeSub();
    await subscriptions.upsert(sub);

    sender.setDefaultResponse({ ok: false, statusCode: 410 });

    const service = new PushService({ workflowRepo, subscriptions, sender, signal: controller.signal, log: silentLogger() });
    service.attach("wf-1");

    await new Promise((r) => setImmediate(r));

    // Save a new version of the workflow with the terminal event
    const wf2 = { ...wf, version: wf.version + 1, updatedAt: nowStr };
    await workflowRepo.save(wf2, [terminalEvent()]);

    await new Promise((r) => setTimeout(r, 50));

    const remaining = await subscriptions.listByWorkflow("wf-1");
    expect(remaining).toHaveLength(0);
    expect(sender.calls).toHaveLength(1);

    controller.abort();
  });

  it("removes subscription on 404", async () => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const subscriptions = new InMemorySubscriptionRepository();
    const sender = new StubPushSender();
    const controller = new AbortController();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, now);
    await workflowRepo.save(wf, []);

    const sub = makeSub();
    await subscriptions.upsert(sub);

    sender.setDefaultResponse({ ok: false, statusCode: 404 });

    const service = new PushService({ workflowRepo, subscriptions, sender, signal: controller.signal, log: silentLogger() });
    service.attach("wf-1");

    await new Promise((r) => setImmediate(r));

    const wf2 = { ...wf, version: wf.version + 1, updatedAt: nowStr };
    await workflowRepo.save(wf2, [terminalEvent()]);

    await new Promise((r) => setTimeout(r, 50));

    const remaining = await subscriptions.listByWorkflow("wf-1");
    expect(remaining).toHaveLength(0);

    controller.abort();
  });

  it("keeps subscription and logs on 500-class error", async () => {
    const { sink, records } = makeCapturingSink();
    const log = createLogger("debug", [sink]);

    const workflowRepo = new InMemoryWorkflowRepository();
    const subscriptions = new InMemorySubscriptionRepository();
    const sender = new StubPushSender();
    const controller = new AbortController();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, now);
    await workflowRepo.save(wf, []);

    const sub = makeSub();
    await subscriptions.upsert(sub);

    sender.setDefaultResponse({ ok: false, statusCode: 500 });

    const service = new PushService({ workflowRepo, subscriptions, sender, signal: controller.signal, log });
    service.attach("wf-1");

    await new Promise((r) => setImmediate(r));

    const wf2 = { ...wf, version: wf.version + 1, updatedAt: nowStr };
    await workflowRepo.save(wf2, [terminalEvent()]);

    await new Promise((r) => setTimeout(r, 50));

    const remaining = await subscriptions.listByWorkflow("wf-1");
    expect(remaining).toHaveLength(1);
    expect(records.some((r) => r.lvl === "error")).toBe(true);

    controller.abort();
  });
});
