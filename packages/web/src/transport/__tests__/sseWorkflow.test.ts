import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Connection } from "../../connections/store.js";
import type { WorkflowEvent } from "@minions/engine";

const CONN: Connection = {
  id: "conn-sse",
  label: "sse",
  baseUrl: "http://engine-sse",
  token: "tok",
  color: "#fff",
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  readonly listeners = new Map<string, Set<(e: { type: string; data?: string }) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(kind: string, handler: (e: { type: string; data?: string }) => void): void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    set.add(handler);
  }
  removeEventListener(kind: string, handler: (e: { type: string; data?: string }) => void): void {
    this.listeners.get(kind)?.delete(handler);
  }
  close(): void {
    this.closed = true;
  }
  fire(kind: string, payload?: unknown): void {
    const event =
      payload === undefined
        ? { type: kind }
        : { type: kind, data: JSON.stringify(payload) };
    for (const h of [...(this.listeners.get(kind) ?? [])]) h(event);
  }
}

function taskTransitionedEvent(workflowId: string): WorkflowEvent {
  return {
    cursor: 1,
    workflowId,
    occurredAt: "2026-01-01T00:00:00Z",
    kind: "task-transitioned",
    payload: {
      taskId: "t-1",
      fromExecutionStatus: "pending",
      toExecutionStatus: "running",
      fromStackStatus: "clean",
      toStackStatus: "clean",
      taskVersion: 2,
    },
  };
}

describe("connectWorkflowSse", () => {
  beforeEach(() => {
    FakeEventSource.instances.length = 0;
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens SSE to /workflows/:id/events", async () => {
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-1", {});

    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("http://engine-sse/workflows/wf-1/events?token=tok");

    conn.close();
  });

  it("calls onEvent with a WorkflowEvent on task-transitioned", async () => {
    const onEvent = vi.fn();
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-1", { onEvent });

    const es = FakeEventSource.instances[0]!;
    const event = taskTransitionedEvent("wf-1");
    es.fire("task-transitioned", event);

    expect(onEvent).toHaveBeenCalledOnce();
    const received = onEvent.mock.calls[0]?.[0] as WorkflowEvent;
    expect(received.kind).toBe("task-transitioned");
    expect(received.workflowId).toBe("wf-1");
    if (received.kind === "task-transitioned") {
      expect(received.payload.toExecutionStatus).toBe("running");
    }

    conn.close();
  });

  it("calls onEvent for ci-poll-result events", async () => {
    const onEvent = vi.fn();
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-ci", { onEvent });

    const es = FakeEventSource.instances[0]!;
    const ciEvent: WorkflowEvent = {
      cursor: 0,
      workflowId: "wf-ci",
      occurredAt: "2026-01-01T00:00:02Z",
      kind: "ci-poll-result",
      payload: {
        taskId: "wf-ci:task",
        prNumber: 7,
        headSha: "deadbeef",
        overallStatus: "pending",
        checks: [
          { name: "ci/test", status: "in_progress", conclusion: null },
        ],
      },
    };
    es.fire("ci-poll-result", ciEvent);

    expect(onEvent).toHaveBeenCalledOnce();
    const received = onEvent.mock.calls[0]?.[0] as WorkflowEvent;
    expect(received.kind).toBe("ci-poll-result");
    if (received.kind === "ci-poll-result") {
      expect(received.payload.prNumber).toBe(7);
      expect(received.payload.overallStatus).toBe("pending");
      expect(received.payload.checks[0]?.name).toBe("ci/test");
    }

    conn.close();
  });

  it("calls onEvent for workflow-status-changed events", async () => {
    const onEvent = vi.fn();
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-2", { onEvent });

    const es = FakeEventSource.instances[0]!;
    const statusEvent: WorkflowEvent = {
      cursor: 5,
      workflowId: "wf-2",
      occurredAt: "2026-01-01T00:00:01Z",
      kind: "workflow-status-changed",
      payload: { fromStatus: "active", toStatus: "completed" },
    };
    es.fire("workflow-status-changed", statusEvent);

    expect(onEvent).toHaveBeenCalledOnce();
    const received = onEvent.mock.calls[0]?.[0] as WorkflowEvent;
    expect(received.kind).toBe("workflow-status-changed");

    conn.close();
  });

  it("reconnects with exponential backoff after error", async () => {
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-1", {});

    expect(FakeEventSource.instances).toHaveLength(1);
    const es0 = FakeEventSource.instances[0]!;
    es0.fire("error");
    expect(es0.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(FakeEventSource.instances).toHaveLength(2);

    conn.close();
  });

  it("does not reconnect after close", async () => {
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-1", {});

    conn.close();
    const es0 = FakeEventSource.instances[0]!;
    es0.fire("error");

    await vi.advanceTimersByTimeAsync(31_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("ignores malformed JSON without throwing", async () => {
    const onEvent = vi.fn();
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-1", { onEvent });

    const es = FakeEventSource.instances[0]!;
    const badEvent = { type: "task-transitioned", data: "{ not json" };
    for (const h of [...(es["listeners"].get("task-transitioned") ?? [])]) h(badEvent);

    expect(onEvent).not.toHaveBeenCalled();

    conn.close();
  });

  it("reconnects with since=<lastCursor> after receiving events, not from 0", async () => {
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-cursor", {});

    const es0 = FakeEventSource.instances[0]!;
    expect(es0.url).toBe("http://engine-sse/workflows/wf-cursor/events?token=tok");

    es0.fire("task-transitioned", { ...taskTransitionedEvent("wf-cursor"), cursor: 7 });
    es0.fire("task-transitioned", { ...taskTransitionedEvent("wf-cursor"), cursor: 12 });

    es0.fire("error");
    await vi.advanceTimersByTimeAsync(31_000);

    expect(FakeEventSource.instances).toHaveLength(2);
    const es1 = FakeEventSource.instances[1]!;
    expect(es1.url).toBe("http://engine-sse/workflows/wf-cursor/events?since=12&token=tok");

    conn.close();
  });

  it("forceReconnect also uses the last seen cursor", async () => {
    const { connectWorkflowSse } = await import("../sse.js");
    const { sseStatusStore } = await import("../sseStatus.js");
    const connKey = `${CONN.id}:wf-force`;
    const conn = connectWorkflowSse(CONN, "wf-force", {});

    const es0 = FakeEventSource.instances[0]!;
    es0.fire("workflow-status-changed", {
      cursor: 3,
      workflowId: "wf-force",
      occurredAt: "2026-01-01T00:00:00Z",
      kind: "workflow-status-changed",
      payload: { fromStatus: "active", toStatus: "completed" },
    });

    sseStatusStore.forceReconnect(connKey);

    expect(FakeEventSource.instances).toHaveLength(2);
    const es1 = FakeEventSource.instances[1]!;
    expect(es1.url).toBe("http://engine-sse/workflows/wf-force/events?since=3&token=tok");

    conn.close();
  });

  it("does not append since= on first connect when no events received", async () => {
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-fresh", {});

    const es0 = FakeEventSource.instances[0]!;
    expect(es0.url).toBe("http://engine-sse/workflows/wf-fresh/events?token=tok");

    conn.close();
  });
});
