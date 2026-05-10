/**
 * Connection isolation tests, migrated from sessionStore to workflowStore.
 * Verifies that each connection's workflow state is stored independently.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Workflow, TaskNode } from "@minions/engine-next";
import { useWorkflowStore } from "../workflowStore.js";

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

function makeWorkflow(id: string, task: TaskNode): Workflow {
  const now = "2026-05-01T00:00:00.000Z";
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

describe("workflowStore connection isolation", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ byConnection: new Map() });
  });

  it("keeps workflows on different connections separate", () => {
    const wfA = makeWorkflow("wf-alpha", makeTask("t1", "wf-alpha"));
    const wfB = makeWorkflow("wf-beta", makeTask("t2", "wf-beta"));
    useWorkflowStore.getState().upsert("conn-a", wfA);
    useWorkflowStore.getState().upsert("conn-b", wfB);

    const after = useWorkflowStore.getState().byConnection;
    expect(after.get("conn-a")?.has("wf-alpha")).toBe(true);
    expect(after.get("conn-a")?.has("wf-beta")).toBe(false);
    expect(after.get("conn-b")?.has("wf-beta")).toBe(true);
    expect(after.get("conn-b")?.has("wf-alpha")).toBe(false);
  });

  it("replaceAll on one connection does not clear the other", () => {
    const wfA = makeWorkflow("wf-alpha", makeTask("t1", "wf-alpha"));
    const wfB = makeWorkflow("wf-beta", makeTask("t2", "wf-beta"));
    useWorkflowStore.getState().upsert("conn-a", wfA);
    useWorkflowStore.getState().upsert("conn-b", wfB);

    const wfGamma = makeWorkflow("wf-gamma", makeTask("t3", "wf-gamma"));
    useWorkflowStore.getState().replaceAll("conn-a", [wfGamma]);

    const after = useWorkflowStore.getState().byConnection;
    expect([...(after.get("conn-a")?.keys() ?? [])]).toEqual(["wf-gamma"]);
    expect(after.get("conn-b")?.has("wf-beta")).toBe(true);
  });

  it("remove on one connection does not touch the other's same-id workflow", () => {
    const wfA = makeWorkflow("shared-id", makeTask("t1", "shared-id"));
    const wfB = makeWorkflow("shared-id", makeTask("t2", "shared-id"));
    useWorkflowStore.getState().upsert("conn-a", wfA);
    useWorkflowStore.getState().upsert("conn-b", wfB);

    useWorkflowStore.getState().remove("conn-a", "shared-id");

    const after = useWorkflowStore.getState().byConnection;
    expect(after.get("conn-a")?.has("shared-id")).toBe(false);
    expect(after.get("conn-b")?.has("shared-id")).toBe(true);
  });

  it("applyEvent for one connection does not affect the other", () => {
    const task = makeTask("t1", "wf1");
    const wf = makeWorkflow("wf1", task);
    useWorkflowStore.getState().replaceAll("conn-a", [wf]);
    useWorkflowStore.getState().replaceAll("conn-b", [{ ...wf }]);

    useWorkflowStore.getState().applyEvent("conn-a", {
      cursor: 1,
      workflowId: "wf1",
      occurredAt: "2026-05-01T01:00:00.000Z",
      kind: "workflow-status-changed",
      payload: { fromStatus: "active", toStatus: "completed" },
    });

    const aStatus = useWorkflowStore.getState().byConnection.get("conn-a")?.get("wf1")?.status;
    const bStatus = useWorkflowStore.getState().byConnection.get("conn-b")?.get("wf1")?.status;
    expect(aStatus).toBe("completed");
    expect(bStatus).toBe("active");
  });
});
