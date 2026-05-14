import { describe, it, expect, beforeEach } from "vitest";
import type { Workflow, TaskNode, WorkflowEvent } from "@minions/engine";
import { useWorkflowStore, selectTaskNodes, selectTaskNode } from "../workflowStore.js";

const CONN = "conn-1";
const CONN2 = "conn-2";

function makeTask(id: string, workflowId: string, overrides: Partial<TaskNode> = {}): TaskNode {
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
    ...overrides,
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

describe("useWorkflowStore — hydrate from snapshot", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ byConnection: new Map() });
  });

  it("replaceAll hydrates multiple workflows for a connection", () => {
    const wf1 = makeWorkflow("wf1", [makeTask("t1", "wf1")]);
    const wf2 = makeWorkflow("wf2", [makeTask("t2", "wf2")]);
    useWorkflowStore.getState().replaceAll(CONN, [wf1, wf2]);

    const slice = useWorkflowStore.getState().byConnection.get(CONN);
    expect(slice?.size).toBe(2);
    expect(slice?.get("wf1")).toEqual(wf1);
    expect(slice?.get("wf2")).toEqual(wf2);
  });

  it("replaceAll on one connection does not clear the other", () => {
    const wf1 = makeWorkflow("wf1", [makeTask("t1", "wf1")]);
    const wf2 = makeWorkflow("wf2", [makeTask("t2", "wf2")]);
    useWorkflowStore.getState().replaceAll(CONN, [wf1]);
    useWorkflowStore.getState().replaceAll(CONN2, [wf2]);

    useWorkflowStore.getState().replaceAll(CONN, []);
    expect(useWorkflowStore.getState().byConnection.get(CONN)?.size).toBe(0);
    expect(useWorkflowStore.getState().byConnection.get(CONN2)?.get("wf2")).toEqual(wf2);
  });
});

describe("useWorkflowStore — applyEvent delta", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ byConnection: new Map() });
  });

  it("workflow-status-changed updates status in place", () => {
    const wf = makeWorkflow("wf1", [makeTask("t1", "wf1")]);
    useWorkflowStore.getState().replaceAll(CONN, [wf]);

    const event: WorkflowEvent = {
      cursor: 1,
      workflowId: "wf1",
      occurredAt: "2026-05-01T01:00:00.000Z",
      kind: "workflow-status-changed",
      payload: { fromStatus: "active", toStatus: "completed" },
    };
    useWorkflowStore.getState().applyEvent(CONN, event);

    const stored = useWorkflowStore.getState().byConnection.get(CONN)?.get("wf1");
    expect(stored?.status).toBe("completed");
  });

  it("task-transitioned updates a task's execution status", () => {
    const task = makeTask("t1", "wf1");
    const wf = makeWorkflow("wf1", [task]);
    useWorkflowStore.getState().replaceAll(CONN, [wf]);

    const event: WorkflowEvent = {
      cursor: 2,
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
    };
    useWorkflowStore.getState().applyEvent(CONN, event);

    const stored = useWorkflowStore.getState().byConnection.get(CONN)?.get("wf1");
    expect(stored?.graph["t1"]?.executionStatus).toBe("running");
    expect(stored?.graph["t1"]?.version).toBe(2);
  });

  it("task-transitioned is a no-op when task version is stale", () => {
    const task = makeTask("t1", "wf1", { version: 5 });
    const wf = makeWorkflow("wf1", [task]);
    useWorkflowStore.getState().replaceAll(CONN, [wf]);

    const event: WorkflowEvent = {
      cursor: 3,
      workflowId: "wf1",
      occurredAt: "2026-05-01T01:00:00.000Z",
      kind: "task-transitioned",
      payload: {
        taskId: "t1",
        fromExecutionStatus: "pending",
        toExecutionStatus: "running",
        fromStackStatus: "clean",
        toStackStatus: "clean",
        taskVersion: 3,
      },
    };
    useWorkflowStore.getState().applyEvent(CONN, event);

    const stored = useWorkflowStore.getState().byConnection.get(CONN)?.get("wf1");
    expect(stored?.graph["t1"]?.executionStatus).toBe("pending");
    expect(stored?.graph["t1"]?.version).toBe(5);
  });

  it("applyEvent for unknown workflowId is a no-op", () => {
    const wf = makeWorkflow("wf1", [makeTask("t1", "wf1")]);
    useWorkflowStore.getState().replaceAll(CONN, [wf]);

    const event: WorkflowEvent = {
      cursor: 1,
      workflowId: "unknown",
      occurredAt: "2026-05-01T01:00:00.000Z",
      kind: "workflow-status-changed",
      payload: { fromStatus: "active", toStatus: "completed" },
    };
    useWorkflowStore.getState().applyEvent(CONN, event);

    const stored = useWorkflowStore.getState().byConnection.get(CONN)?.get("wf1");
    expect(stored?.status).toBe("active");
  });
});

describe("useWorkflowStore — optimistic + rollback", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ byConnection: new Map() });
  });

  it("applyOptimisticWorkflow mutates and rollback restores", () => {
    const wf = makeWorkflow("wf1", [makeTask("t1", "wf1")]);
    useWorkflowStore.getState().replaceAll(CONN, [wf]);

    const rollback = useWorkflowStore.getState().applyOptimisticWorkflow(
      CONN,
      "wf1",
      (prev) => ({ ...prev, status: "completed" }),
    );

    expect(useWorkflowStore.getState().byConnection.get(CONN)?.get("wf1")?.status).toBe("completed");

    rollback();

    expect(useWorkflowStore.getState().byConnection.get(CONN)?.get("wf1")?.status).toBe("active");
  });

  it("applyOptimisticWorkflow is a no-op when workflow is missing", () => {
    const rollback = useWorkflowStore.getState().applyOptimisticWorkflow(
      CONN,
      "missing",
      (prev) => ({ ...prev, status: "completed" }),
    );
    expect(() => rollback()).not.toThrow();
  });
});

describe("selectors", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ byConnection: new Map() });
  });

  it("selectTaskNodes returns tasks from workflow graph", () => {
    const t1 = makeTask("t1", "wf1");
    const t2 = makeTask("t2", "wf1");
    const wf = makeWorkflow("wf1", [t1, t2]);
    useWorkflowStore.getState().replaceAll(CONN, [wf]);

    const tasks = selectTaskNodes(CONN, "wf1");
    expect(tasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });

  it("selectTaskNode returns a specific task", () => {
    const t1 = makeTask("t1", "wf1");
    const wf = makeWorkflow("wf1", [t1]);
    useWorkflowStore.getState().replaceAll(CONN, [wf]);

    expect(selectTaskNode(CONN, "wf1", "t1")).toEqual(t1);
    expect(selectTaskNode(CONN, "wf1", "missing")).toBeUndefined();
  });

  it("selectTaskNodes returns [] for unknown workflow", () => {
    expect(selectTaskNodes(CONN, "nonexistent")).toEqual([]);
  });
});
