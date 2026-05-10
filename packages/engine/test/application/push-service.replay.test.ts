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

function terminalEvent(): WorkflowEvent {
  return {
    cursor: 0,
    workflowId: "wf-1",
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

describe("PushService replay guard (HIGH 1)", () => {
  it("emits 5 historical terminal events then attaches; only 1 new event notifies", async () => {
    const workflowRepo = new InMemoryWorkflowRepository();
    const subscriptions = new InMemorySubscriptionRepository();
    const sender = new StubPushSender();
    const controller = new AbortController();

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, now);
    await workflowRepo.save(wf, []);
    await subscriptions.upsert({ endpoint: "https://push.example.com/s1", workflowId: "wf-1", keys: { p256dh: "k", auth: "a" } });

    // Emit 5 terminal events before attach
    let current = wf;
    for (let i = 0; i < 5; i++) {
      const next = { ...current, version: current.version + 1, updatedAt: nowStr };
      await workflowRepo.save(next, [terminalEvent()]);
      current = next;
    }

    const service = new PushService({ workflowRepo, subscriptions, sender, signal: controller.signal, log: silentLogger() });
    service.attach("wf-1");

    await new Promise((r) => setImmediate(r));

    // Emit 1 new terminal event after attach
    const post = { ...current, version: current.version + 1, updatedAt: nowStr };
    await workflowRepo.save(post, [terminalEvent()]);

    await new Promise((r) => setTimeout(r, 50));

    expect(sender.calls).toHaveLength(1);

    controller.abort();
  });
});
