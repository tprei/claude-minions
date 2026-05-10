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
  return { service, sender, subscriptions, controller };
}

function taskTransitionedEvent(toExecutionStatus: string): WorkflowEvent {
  return {
    cursor: 1,
    workflowId: "wf-1",
    occurredAt: now,
    kind: "task-transitioned",
    payload: {
      taskId: "task-1",
      fromExecutionStatus: "running",
      toExecutionStatus: toExecutionStatus as WorkflowEvent extends { kind: "task-transitioned" } ? never : never,
      fromStackStatus: "clean",
      toStackStatus: "clean",
      taskVersion: 2,
    },
  } as WorkflowEvent;
}

function providerEvent(kind: string, extra: Record<string, unknown> = {}): WorkflowEvent {
  return {
    cursor: 1,
    workflowId: "wf-1",
    occurredAt: now,
    kind: "provider-event",
    payload: {
      taskId: "task-1",
      runId: "run-1",
      providerEvent: { kind, ...extra } as WorkflowEvent extends { kind: "provider-event" } ? never : never,
    },
  } as WorkflowEvent;
}

describe("PushService.shouldNotify — task-transitioned", () => {
  it("fires for completed", () => {
    const { service } = makeService();
    const decision = service.shouldNotify(taskTransitionedEvent("completed"));
    expect(decision).not.toBeNull();
    expect(decision?.code).toBe("done");
    expect(decision?.title).toBe("Task complete");
  });

  it("fires for pr-open", () => {
    const { service } = makeService();
    const decision = service.shouldNotify(taskTransitionedEvent("pr-open"));
    expect(decision?.code).toBe("done");
  });

  it("fires for merged", () => {
    const { service } = makeService();
    const decision = service.shouldNotify(taskTransitionedEvent("merged"));
    expect(decision?.code).toBe("done");
  });

  it("fires for failed", () => {
    const { service } = makeService();
    const decision = service.shouldNotify(taskTransitionedEvent("failed"));
    expect(decision?.code).toBe("failed");
    expect(decision?.title).toBe("Task failed");
  });

  it("fires for cancelled", () => {
    const { service } = makeService();
    const decision = service.shouldNotify(taskTransitionedEvent("cancelled"));
    expect(decision?.code).toBe("failed");
  });

  it("fires for needs-review", () => {
    const { service } = makeService();
    const decision = service.shouldNotify(taskTransitionedEvent("needs-review"));
    expect(decision?.code).toBe("review");
    expect(decision?.title).toBe("Needs review");
  });

  it("does not fire for running (non-terminal)", () => {
    const { service } = makeService();
    expect(service.shouldNotify(taskTransitionedEvent("running"))).toBeNull();
  });

  it("does not fire for pending", () => {
    const { service } = makeService();
    expect(service.shouldNotify(taskTransitionedEvent("pending"))).toBeNull();
  });

  it("does not fire for ready", () => {
    const { service } = makeService();
    expect(service.shouldNotify(taskTransitionedEvent("ready"))).toBeNull();
  });
});

describe("PushService.shouldNotify — provider-event", () => {
  it("fires for permission_request", () => {
    const { service } = makeService();
    const decision = service.shouldNotify(providerEvent("permission_request", { id: "p1", tool: "bash", input: {} }));
    expect(decision).not.toBeNull();
    expect(decision?.code).toBe("perm");
    expect(decision?.title).toBe("Permission needed");
  });

  it("fires for non-recoverable error", () => {
    const { service } = makeService();
    const decision = service.shouldNotify(providerEvent("error", { recoverable: false, message: "crash" }));
    expect(decision).not.toBeNull();
    expect(decision?.code).toBe("error");
    expect(decision?.title).toBe("Task error");
  });

  it("does not fire for recoverable error", () => {
    const { service } = makeService();
    expect(service.shouldNotify(providerEvent("error", { recoverable: true, message: "retry" }))).toBeNull();
  });

  it("does not fire for assistant_text", () => {
    const { service } = makeService();
    expect(service.shouldNotify(providerEvent("assistant_text", { text: "hi" }))).toBeNull();
  });

  it("does not fire for tool_call", () => {
    const { service } = makeService();
    expect(service.shouldNotify(providerEvent("tool_call", { id: "tc1", name: "bash", input: {} }))).toBeNull();
  });

  it("does not fire for tool_result", () => {
    const { service } = makeService();
    expect(service.shouldNotify(providerEvent("tool_result", { id: "tc1", output: "ok" }))).toBeNull();
  });

  it("does not fire for usage", () => {
    const { service } = makeService();
    expect(service.shouldNotify(providerEvent("usage", { inputTokens: 10, outputTokens: 5 }))).toBeNull();
  });

  it("does not fire for thinking", () => {
    const { service } = makeService();
    expect(service.shouldNotify(providerEvent("thinking", { text: "hmm" }))).toBeNull();
  });

  it("does not fire for final", () => {
    const { service } = makeService();
    expect(service.shouldNotify(providerEvent("final", { sessionRef: "abc" }))).toBeNull();
  });
});

describe("PushService.shouldNotify — other event kinds", () => {
  it("does not fire for graph-operation-changed", () => {
    const { service } = makeService();
    const event: WorkflowEvent = {
      cursor: 1,
      workflowId: "wf-1",
      occurredAt: now,
      kind: "graph-operation-changed",
      payload: { operationId: "op1", kind: "restack", fromStatus: null, toStatus: "running" },
    };
    expect(service.shouldNotify(event)).toBeNull();
  });

  it("does not fire for run-started", () => {
    const { service } = makeService();
    const event: WorkflowEvent = {
      cursor: 1,
      workflowId: "wf-1",
      occurredAt: now,
      kind: "run-started",
      payload: {
        runId: "r1",
        taskId: "t1",
        attempt: 1,
        runtimeSessionId: "sess",
        providerType: "stub",
        runtimeType: "stub",
      },
    };
    expect(service.shouldNotify(event)).toBeNull();
  });
});
