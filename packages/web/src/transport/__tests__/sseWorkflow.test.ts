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

const FETCH_MOCK = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();
const encoder = new TextEncoder();
let activeController: ReadableStreamDefaultController<Uint8Array> | null = null;

function streamResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        activeController = controller;
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

function emitSse(kind: string, payload: unknown, id?: number): void {
  const idLine = id !== undefined ? `id: ${id}\n` : "";
  activeController?.enqueue(
    encoder.encode(`${idLine}event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`),
  );
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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
    activeController = null;
    FETCH_MOCK.mockImplementation(() => Promise.resolve(streamResponse()));
    vi.stubGlobal("fetch", FETCH_MOCK);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FETCH_MOCK.mockReset();
  });

  it("opens SSE to /workflows/:id/events", async () => {
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-1", {});
    await flush();

    expect(FETCH_MOCK).toHaveBeenCalledOnce();
    const [url, init] = FETCH_MOCK.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://engine-sse/workflows/wf-1/events");
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer tok");
    expect((init.headers as Headers).get("Accept")).toBe("text/event-stream");

    conn.close();
  });

  it("does not fire onReconnect on the initial open, but does after a reconnect", async () => {
    const onReconnect = vi.fn();
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-1", { onReconnect });
    await flush();

    expect(onReconnect).not.toHaveBeenCalled();

    activeController?.error(new Error("network"));
    await flush();
    await vi.advanceTimersByTimeAsync(31_000);

    expect(onReconnect).toHaveBeenCalledOnce();
    conn.close();
  });

  it("calls onEvent with a WorkflowEvent on task-transitioned", async () => {
    const onEvent = vi.fn();
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-1", { onEvent });
    await flush();

    const event = taskTransitionedEvent("wf-1");
    emitSse("task-transitioned", event, 1);
    await flush();

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
    await flush();

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
    emitSse("ci-poll-result", ciEvent);
    await flush();

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
    await flush();

    const statusEvent: WorkflowEvent = {
      cursor: 5,
      workflowId: "wf-2",
      occurredAt: "2026-01-01T00:00:01Z",
      kind: "workflow-status-changed",
      payload: { fromStatus: "active", toStatus: "completed" },
    };
    emitSse("workflow-status-changed", statusEvent);
    await flush();

    expect(onEvent).toHaveBeenCalledOnce();
    const received = onEvent.mock.calls[0]?.[0] as WorkflowEvent;
    expect(received.kind).toBe("workflow-status-changed");

    conn.close();
  });

  it("reconnects with exponential backoff after error", async () => {
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-1", {});
    await flush();

    expect(FETCH_MOCK).toHaveBeenCalledTimes(1);
    activeController?.error(new Error("network"));
    await flush();

    await vi.advanceTimersByTimeAsync(31_000);
    expect(FETCH_MOCK).toHaveBeenCalledTimes(2);

    conn.close();
  });

  it("reconnects from the last durable SSE id", async () => {
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-1", {});
    await flush();

    emitSse("task-transitioned", taskTransitionedEvent("wf-1"), 9);
    await flush();
    activeController?.error(new Error("network"));
    await flush();

    await vi.advanceTimersByTimeAsync(31_000);
    expect(FETCH_MOCK).toHaveBeenCalledTimes(2);
    const [url] = FETCH_MOCK.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://engine-sse/workflows/wf-1/events?since=9");

    conn.close();
  });

  it("does not reconnect after close", async () => {
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-1", {});
    await flush();

    conn.close();
    activeController?.error(new Error("network"));
    await flush();

    await vi.advanceTimersByTimeAsync(31_000);
    expect(FETCH_MOCK).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed JSON without throwing", async () => {
    const onEvent = vi.fn();
    const { connectWorkflowSse } = await import("../sse.js");
    const conn = connectWorkflowSse(CONN, "wf-1", { onEvent });
    await flush();

    activeController?.enqueue(encoder.encode("event: task-transitioned\ndata: { not json\n\n"));
    await flush();

    expect(onEvent).not.toHaveBeenCalled();

    conn.close();
  });
});
