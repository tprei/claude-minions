import { describe, expect, it } from "vitest";
import { PushService } from "../../src/application/push-service.js";
import { silentLogger } from "../test-helpers.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { InMemorySubscriptionRepository } from "../../src/application/subscription-repository.js";
import { StubPushSender } from "../../src/testing/stub-push-sender.js";
import type { WorkflowEvent } from "../../src/domain/events.js";

const now = "2026-05-04T11:19:00.000Z";

function makeService() {
  const workflowRepo = new InMemoryWorkflowRepository();
  const subscriptions = new InMemorySubscriptionRepository();
  const sender = new StubPushSender();
  const controller = new AbortController();
  const service = new PushService({ workflowRepo, subscriptions, sender, signal: controller.signal, log: silentLogger() });
  return { service };
}

describe("PushService.buildPayload", () => {
  it("builds correct payload for terminal task-transitioned (completed)", () => {
    const { service } = makeService();
    const event: WorkflowEvent = {
      cursor: 5,
      workflowId: "wf-abc",
      occurredAt: now,
      kind: "task-transitioned",
      payload: {
        taskId: "task-xyz",
        fromExecutionStatus: "running",
        toExecutionStatus: "completed",
        fromStackStatus: "clean",
        toStackStatus: "clean",
        taskVersion: 3,
      },
    };
    const decision = service.shouldNotify(event)!;
    const payload = service.buildPayload("wf-abc", event, decision);

    expect(payload.tag).toBe("wf-abc:task-xyz:done");
    expect(payload.title).toBe("Task complete");
    expect(payload.body).toBe("task-xyz: completed");
    expect(payload.workflowId).toBe("wf-abc");
    expect(payload.taskId).toBe("task-xyz");
    expect(payload.code).toBe("done");
    expect(payload.cursor).toBe(5);
    expect(payload.url).toBe("/workflows/wf-abc?task=task-xyz");
  });

  it("builds correct payload for permission_request", () => {
    const { service } = makeService();
    const event: WorkflowEvent = {
      cursor: 7,
      workflowId: "wf-1",
      occurredAt: now,
      kind: "provider-event",
      payload: {
        taskId: "t1",
        runId: "r1",
        providerEvent: { kind: "permission_request", id: "p1", tool: "bash", input: {} },
      },
    };
    const decision = service.shouldNotify(event)!;
    const payload = service.buildPayload("wf-1", event, decision);

    expect(payload.tag).toBe("wf-1:t1:perm");
    expect(payload.title).toBe("Permission needed");
    expect(payload.code).toBe("perm");
    expect(payload.cursor).toBe(7);
    expect(payload.url).toBe("/workflows/wf-1?task=t1");
  });

  it("builds correct payload for non-recoverable error", () => {
    const { service } = makeService();
    const event: WorkflowEvent = {
      cursor: 9,
      workflowId: "wf-1",
      occurredAt: now,
      kind: "provider-event",
      payload: {
        taskId: "t1",
        runId: "r1",
        providerEvent: { kind: "error", recoverable: false, message: "Fatal crash occurred" },
      },
    };
    const decision = service.shouldNotify(event)!;
    const payload = service.buildPayload("wf-1", event, decision);

    expect(payload.tag).toBe("wf-1:t1:error");
    expect(payload.title).toBe("Task error");
    expect(payload.code).toBe("error");
    expect(payload.body).toContain("Fatal crash occurred");
  });

  it("truncates long taskId in body to 30 chars", () => {
    const { service } = makeService();
    const longId = "a".repeat(40);
    const event: WorkflowEvent = {
      cursor: 1,
      workflowId: "wf-1",
      occurredAt: now,
      kind: "task-transitioned",
      payload: {
        taskId: longId,
        fromExecutionStatus: "running",
        toExecutionStatus: "failed",
        fromStackStatus: "clean",
        toStackStatus: "clean",
        taskVersion: 1,
      },
    };
    const decision = service.shouldNotify(event)!;
    const payload = service.buildPayload("wf-1", event, decision);
    // body starts with truncated taskId
    const bodyTaskPart = payload.body.split(":")[0];
    expect(bodyTaskPart!.length).toBeLessThanOrEqual(31); // 30 + ellipsis
  });
});
