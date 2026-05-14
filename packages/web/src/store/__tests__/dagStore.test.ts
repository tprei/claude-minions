/**
 * Migrated from dagStore. The DAG concept has been unified into Workflow.
 * Tests here verify upsert and remove operations on the workflowStore
 * since useDagStore is now a re-export alias of useWorkflowStore.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Workflow, TaskNode } from "@minions/engine";
import { useWorkflowStore } from "../workflowStore.js";

const CONN = "conn-1";

function makeTask(id: string, workflowId: string): TaskNode {
  const now = "2026-05-01T00:00:00.000Z";
  return {
    id,
    workflowId,
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

function makeWorkflow(id: string, tasks: TaskNode[]): Workflow {
  const now = "2026-05-01T00:00:00.000Z";
  const graph: Record<string, TaskNode> = {};
  for (const t of tasks) graph[t.id] = t;
  return {
    id,
    kind: "single-task",
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

describe("useWorkflowStore.upsert / remove", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ byConnection: new Map() });
  });

  it("upsert adds a workflow", () => {
    const wf = makeWorkflow("wf1", [makeTask("t1", "wf1")]);
    useWorkflowStore.getState().upsert(CONN, wf);
    expect(useWorkflowStore.getState().byConnection.get(CONN)?.get("wf1")).toEqual(wf);
  });

  it("remove deletes a workflow", () => {
    const wf = makeWorkflow("wf1", [makeTask("t1", "wf1")]);
    useWorkflowStore.getState().upsert(CONN, wf);
    useWorkflowStore.getState().remove(CONN, "wf1");
    expect(useWorkflowStore.getState().byConnection.get(CONN)?.get("wf1")).toBeUndefined();
  });

  it("remove on unknown id is a no-op", () => {
    const wf = makeWorkflow("wf1", [makeTask("t1", "wf1")]);
    useWorkflowStore.getState().upsert(CONN, wf);
    useWorkflowStore.getState().remove(CONN, "missing");
    expect(useWorkflowStore.getState().byConnection.get(CONN)?.size).toBe(1);
  });

  it("applyEvent task-transitioned patches a task in place", () => {
    const task = makeTask("t1", "wf1");
    const wf = makeWorkflow("wf1", [task]);
    useWorkflowStore.getState().replaceAll(CONN, [wf]);

    useWorkflowStore.getState().applyEvent(CONN, {
      cursor: 1,
      workflowId: "wf1",
      occurredAt: "2026-05-01T01:00:00.000Z",
      kind: "task-transitioned",
      payload: {
        taskId: "t1",
        fromExecutionStatus: "pending",
        toExecutionStatus: "running",
        fromStackStatus: "clean",
        toStackStatus: "clean",
        taskVersion: 2,
      },
    });

    const stored = useWorkflowStore.getState().byConnection.get(CONN)?.get("wf1");
    expect(stored?.graph["t1"]?.executionStatus).toBe("running");
  });

  it("applyEvent is a no-op when the workflow is unknown", () => {
    useWorkflowStore.getState().applyEvent(CONN, {
      cursor: 1,
      workflowId: "missing",
      occurredAt: "2026-05-01T01:00:00.000Z",
      kind: "workflow-status-changed",
      payload: { fromStatus: "active", toStatus: "completed" },
    });
    expect(useWorkflowStore.getState().byConnection.get(CONN)).toBeUndefined();
  });
});
