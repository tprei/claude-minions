/**
 * Migrated from sessionStore transcript merge tests.
 *
 * The transcript concept (SSE text streaming) has no direct analog in the
 * engine-next Workflow domain — provider events arrive as WorkflowEvents of
 * kind "provider-event" and are not accumulated in the workflow store.
 * This file now tests delta-application ordering on the workflowStore,
 * which is the closest analog to the old sequence-ordered transcript merge.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Workflow, TaskNode, WorkflowEvent } from "@minions/engine";
import { useWorkflowStore } from "../workflowStore.js";

const CONN = "conn-1";
const WF_ID = "wf-demo";

function makeTask(id: string): TaskNode {
  const now = "2026-05-01T00:00:00.000Z";
  return {
    id,
    workflowId: WF_ID,
    title: id,
    prompt: `do ${id}`,
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

function makeWorkflow(tasks: TaskNode[]): Workflow {
  const now = "2026-05-01T00:00:00.000Z";
  const graph: Record<string, TaskNode> = {};
  for (const t of tasks) graph[t.id] = t;
  return {
    id: WF_ID,
    kind: "manual-dag",
    repoId: "fixture-repo",
    status: "active",
    graph,
    operations: {},
    policy: { maxConcurrent: 3, autoLand: false, autoMergeOnGreen: false },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function taskTransition(
  taskId: string,
  toExec: TaskNode["executionStatus"],
  taskVersion: number,
): WorkflowEvent {
  return {
    cursor: taskVersion,
    workflowId: WF_ID,
    occurredAt: "2026-05-01T01:00:00.000Z",
    kind: "task-transitioned",
    payload: {
      taskId,
      fromExecutionStatus: "pending",
      toExecutionStatus: toExec,
      fromStackStatus: "clean",
      toStackStatus: "clean",
      taskVersion,
    },
  };
}

describe("workflowStore delta ordering and version gating", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ byConnection: new Map() });
  });

  it("applies sequential transitions in order", () => {
    const wf = makeWorkflow([makeTask("t1"), makeTask("t2")]);
    useWorkflowStore.getState().replaceAll(CONN, [wf]);

    useWorkflowStore.getState().applyEvent(CONN, taskTransition("t1", "ready", 2));
    useWorkflowStore.getState().applyEvent(CONN, taskTransition("t1", "running", 3));

    const stored = useWorkflowStore.getState().byConnection.get(CONN)?.get(WF_ID);
    expect(stored?.graph["t1"]?.executionStatus).toBe("running");
    expect(stored?.graph["t1"]?.version).toBe(3);
  });

  it("ignores a stale event (version lower than task version)", () => {
    const task = makeTask("t1");
    const wf = makeWorkflow([{ ...task, version: 5, executionStatus: "running" }]);
    useWorkflowStore.getState().replaceAll(CONN, [wf]);

    useWorkflowStore.getState().applyEvent(CONN, taskTransition("t1", "failed", 2));

    const stored = useWorkflowStore.getState().byConnection.get(CONN)?.get(WF_ID);
    expect(stored?.graph["t1"]?.executionStatus).toBe("running");
    expect(stored?.graph["t1"]?.version).toBe(5);
  });

  it("applies a newer transition after a stale one is ignored", () => {
    const task = makeTask("t1");
    const wf = makeWorkflow([{ ...task, version: 3, executionStatus: "running" }]);
    useWorkflowStore.getState().replaceAll(CONN, [wf]);

    useWorkflowStore.getState().applyEvent(CONN, taskTransition("t1", "failed", 2));
    useWorkflowStore.getState().applyEvent(CONN, taskTransition("t1", "completed", 4));

    const stored = useWorkflowStore.getState().byConnection.get(CONN)?.get(WF_ID);
    expect(stored?.graph["t1"]?.executionStatus).toBe("completed");
    expect(stored?.graph["t1"]?.version).toBe(4);
  });

  it("workflow-status-changed and task-transitioned can interleave", () => {
    const wf = makeWorkflow([makeTask("t1")]);
    useWorkflowStore.getState().replaceAll(CONN, [wf]);

    useWorkflowStore.getState().applyEvent(CONN, taskTransition("t1", "completed", 2));
    useWorkflowStore.getState().applyEvent(CONN, {
      cursor: 3,
      workflowId: WF_ID,
      occurredAt: "2026-05-01T02:00:00.000Z",
      kind: "workflow-status-changed",
      payload: { fromStatus: "active", toStatus: "completed" },
    });

    const stored = useWorkflowStore.getState().byConnection.get(CONN)?.get(WF_ID);
    expect(stored?.graph["t1"]?.executionStatus).toBe("completed");
    expect(stored?.status).toBe("completed");
  });
});
