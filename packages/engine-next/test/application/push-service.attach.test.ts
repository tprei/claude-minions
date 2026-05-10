import { describe, expect, it } from "vitest";
import { PushService } from "../../src/application/push-service.js";
import { silentLogger } from "../test-helpers.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { InMemorySubscriptionRepository } from "../../src/application/subscription-repository.js";
import { StubPushSender } from "../../src/testing/stub-push-sender.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import type { WorkflowEvent } from "../../src/domain/events.js";

const nowStr = "2026-05-04T11:19:00.000Z";
const now = () => nowStr;

const TASK_ID = "wf-1:task";

function terminalEvent(workflowId = "wf-1"): WorkflowEvent {
  return {
    cursor: 0,
    workflowId,
    occurredAt: nowStr,
    kind: "task-transitioned",
    payload: {
      taskId: TASK_ID,
      fromExecutionStatus: "running",
      toExecutionStatus: "completed",
      fromStackStatus: "clean",
      toStackStatus: "clean",
      taskVersion: 2,
    },
  };
}

describe("PushService.attach", () => {
  it("does not replay historical terminal events — only notifies for events after attach", async () => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const subscriptions = new InMemorySubscriptionRepository();
    const sender = new StubPushSender();
    const controller = new AbortController();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, now);
    await workflowRepo.save(wf, []);
    await subscriptions.upsert({ endpoint: "https://push.example.com/s1", workflowId: "wf-1", keys: { p256dh: "k", auth: "a" } });

    // Save 3 terminal events before attaching
    const wf2 = { ...wf, version: wf.version + 1, updatedAt: nowStr };
    await workflowRepo.save(wf2, [terminalEvent(), terminalEvent(), terminalEvent()]);

    const service = new PushService({ workflowRepo, subscriptions, sender, signal: controller.signal, log: silentLogger() });
    service.attach("wf-1");

    await new Promise((r) => setImmediate(r));

    // Save 1 new terminal event after attach
    const wf3 = { ...wf2, version: wf2.version + 1, updatedAt: nowStr };
    await workflowRepo.save(wf3, [terminalEvent("wf-1")]);

    await new Promise((r) => setTimeout(r, 50));

    // Must receive exactly 1 notification for the post-attach event only
    expect(sender.calls).toHaveLength(1);

    controller.abort();
  });

  it("sends notification when a terminal event fires after attach", async () => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const subscriptions = new InMemorySubscriptionRepository();
    const sender = new StubPushSender();
    const controller = new AbortController();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, now);
    await workflowRepo.save(wf, []);
    await subscriptions.upsert({ endpoint: "https://push.example.com/s1", workflowId: "wf-1", keys: { p256dh: "k", auth: "a" } });

    const service = new PushService({ workflowRepo, subscriptions, sender, signal: controller.signal, log: silentLogger() });
    service.attach("wf-1");

    await new Promise((r) => setImmediate(r));

    // Bump version by 1 so save() accepts the update
    const wf2 = { ...wf, version: wf.version + 1, updatedAt: nowStr };
    await workflowRepo.save(wf2, [terminalEvent()]);

    await new Promise((r) => setTimeout(r, 50));

    expect(sender.calls).toHaveLength(1);
    const parsed = JSON.parse(sender.calls[0]!.payload);
    expect(parsed.code).toBe("done");
    expect(parsed.workflowId).toBe("wf-1");

    controller.abort();
  });

  it("attach is idempotent — second attach does not spawn duplicate consumer", async () => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const subscriptions = new InMemorySubscriptionRepository();
    const sender = new StubPushSender();
    const controller = new AbortController();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, now);
    await workflowRepo.save(wf, []);
    await subscriptions.upsert({ endpoint: "https://push.example.com/s1", workflowId: "wf-1", keys: { p256dh: "k", auth: "a" } });

    const service = new PushService({ workflowRepo, subscriptions, sender, signal: controller.signal, log: silentLogger() });
    service.attach("wf-1");
    service.attach("wf-1");
    service.attach("wf-1");

    await new Promise((r) => setImmediate(r));

    const wf2 = { ...wf, version: wf.version + 1, updatedAt: nowStr };
    await workflowRepo.save(wf2, [terminalEvent()]);

    await new Promise((r) => setTimeout(r, 50));

    // Only one consumer → one send
    expect(sender.calls).toHaveLength(1);

    controller.abort();
  });

  it("abort signal stops consumer loop", async () => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const subscriptions = new InMemorySubscriptionRepository();
    const sender = new StubPushSender();
    const controller = new AbortController();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, now);
    await workflowRepo.save(wf, []);
    await subscriptions.upsert({ endpoint: "https://push.example.com/s1", workflowId: "wf-1", keys: { p256dh: "k", auth: "a" } });

    const service = new PushService({ workflowRepo, subscriptions, sender, signal: controller.signal, log: silentLogger() });
    service.attach("wf-1");

    await new Promise((r) => setImmediate(r));

    // Abort before any event
    controller.abort();

    // Give consumer time to exit
    await new Promise((r) => setTimeout(r, 20));

    const wf2 = { ...wf, version: wf.version + 1, updatedAt: nowStr };
    await workflowRepo.save(wf2, [terminalEvent()]);

    await new Promise((r) => setTimeout(r, 50));

    // Consumer stopped; no sends
    expect(sender.calls).toHaveLength(0);
  });
});
