import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow, WorkflowEvent, TaskNode } from "@minions/engine";
import type { Connection } from "../connections/store.js";
import { useWorkflowStore } from "./workflowStore.js";
import { attachConnection, subscribeWorkflowStream } from "./connectionState.js";
import { connectWorkflowSse } from "../transport/sse.js";
import { getVersion, listWorkflows } from "../transport/rest.js";

const sse = vi.hoisted(() => ({
  closeFns: [] as Array<ReturnType<typeof vi.fn>>,
  reconnectHandlers: [] as Array<() => Promise<void>>,
  eventHandlers: new Map<string, (event: WorkflowEvent) => void>(),
  connectWorkflowSse: vi.fn(),
}));

vi.mock("../transport/sse.js", () => ({
  connectWorkflowSse: sse.connectWorkflowSse,
}));

vi.mock("../transport/rest.js", () => ({
  getVersion: vi.fn(),
  listWorkflows: vi.fn(),
}));

vi.mock("../transport/snapshotCache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../transport/snapshotCache.js")>();
  return {
    ...actual,
    loadSnapshot: vi.fn(async () => null),
    saveSnapshot: vi.fn(async () => {}),
  };
});

const conn: Connection = {
  id: "conn-1",
  label: "Local",
  baseUrl: "http://engine.test",
  token: "",
  color: "#34d399",
};

function makeTask(id: string, workflowId: string): TaskNode {
  const now = "2026-05-14T00:00:00.000Z";
  return {
    id,
    workflowId,
    title: id,
    prompt: id,
    dependsOn: [],
    executionStatus: "pending",
    stackStatus: "clean",
    priority: 0,
    claims: [],
    contract: { summary: id, expectedArtifacts: [] },
    artifacts: [],
    runs: [],
    readiness: "unknown",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function makeWorkflow(id: string): Workflow {
  const now = "2026-05-14T00:00:00.000Z";
  const task = makeTask(`${id}:task`, id);
  return {
    id,
    kind: "single-task",
    repoId: "fixture-repo",
    status: "active",
    graph: { [task.id]: task },
    operations: {},
    policy: { maxConcurrent: 3, autoLand: false, autoMergeOnGreen: false },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

describe("attachConnection", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ byConnection: new Map() });
    sse.closeFns = [];
    sse.reconnectHandlers = [];
    sse.eventHandlers = new Map();
    vi.mocked(getVersion).mockResolvedValue({
      apiVersion: "1.0",
      libraryVersion: "0.1.0",
      buildSha: "sha",
      provider: "stub",
      providers: ["stub"],
      features: [],
      featuresPending: [],
      repos: [],
      pluginSet: [],
      startedAt: "2026-05-20T00:00:00.000Z",
    });
    vi.mocked(listWorkflows).mockResolvedValue([makeWorkflow("wf-a"), makeWorkflow("wf-b")]);
    sse.connectWorkflowSse.mockImplementation((_conn, workflowId, handlers) => {
      const close = vi.fn();
      sse.closeFns.push(close);
      if (handlers.onReconnect) sse.reconnectHandlers.push(handlers.onReconnect);
      if (handlers.onEvent) sse.eventHandlers.set(workflowId, handlers.onEvent);
      return { close };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens workflow SSE when a workflow is created after attach", () => {
    const dispose = attachConnection(conn, 10_000);

    useWorkflowStore.getState().upsert(conn.id, makeWorkflow("wf-new"));

    expect(connectWorkflowSse).toHaveBeenCalledTimes(1);
    expect(connectWorkflowSse).toHaveBeenCalledWith(
      conn,
      "wf-new",
      expect.objectContaining({
        onEvent: expect.any(Function),
        onReconnect: expect.any(Function),
      }),
    );

    dispose();
    expect(sse.closeFns[0]).toHaveBeenCalledOnce();
  });

  it("deduplicates reconnect-triggered refetches across workflow streams on one connection", async () => {
    const dispose = attachConnection(conn, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(connectWorkflowSse).toHaveBeenCalledTimes(2);
    expect(getVersion).toHaveBeenCalledTimes(1);
    expect(listWorkflows).toHaveBeenCalledTimes(1);

    await Promise.all(sse.reconnectHandlers.map((handler) => handler()));

    expect(getVersion).toHaveBeenCalledTimes(2);
    expect(listWorkflows).toHaveBeenCalledTimes(2);

    dispose();
  });

  it("fans out workflow events to local subscribers", async () => {
    const received: WorkflowEvent[] = [];
    const unsubscribe = subscribeWorkflowStream(conn.id, "wf-a", {
      onEvent(event) {
        received.push(event);
      },
    });

    const dispose = attachConnection(conn, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event: WorkflowEvent = {
      cursor: 0,
      workflowId: "wf-a",
      occurredAt: "2026-05-20T00:00:00.000Z",
      kind: "provider-event",
      payload: {
        taskId: "wf-a:task",
        runId: "run-1",
        providerEvent: { kind: "assistant_text", text: "hello" },
      },
    };

    sse.eventHandlers.get("wf-a")?.(event);

    expect(received).toEqual([event]);

    unsubscribe();
    dispose();
  });

  it("fans out workflow reconnects to local subscribers", async () => {
    const onReconnect = vi.fn();
    const unsubscribe = subscribeWorkflowStream(conn.id, "wf-a", { onReconnect });

    const dispose = attachConnection(conn, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await sse.reconnectHandlers[0]?.();

    expect(onReconnect).toHaveBeenCalledOnce();

    unsubscribe();
    dispose();
  });
});
