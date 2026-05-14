import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow, TaskNode } from "@minions/engine";
import type { Connection } from "../connections/store.js";
import { useWorkflowStore } from "./workflowStore.js";
import { attachConnection } from "./connectionState.js";
import { connectWorkflowSse } from "../transport/sse.js";

const sse = vi.hoisted(() => ({
  closeFns: [] as Array<ReturnType<typeof vi.fn>>,
  connectWorkflowSse: vi.fn(),
}));

vi.mock("../transport/sse.js", () => ({
  connectWorkflowSse: sse.connectWorkflowSse,
}));

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
    sse.connectWorkflowSse.mockImplementation(() => {
      const close = vi.fn();
      sse.closeFns.push(close);
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
});
