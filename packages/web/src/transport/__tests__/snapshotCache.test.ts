import { describe, it, expect } from "vitest";
import type { Workflow, WorkflowEvent } from "@minions/engine";
import { applyEventToSnapshot } from "../snapshotCache.js";
import type { ConnectionSnapshot } from "../snapshotCache.js";

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    kind: "single-task",
    status: "active",
    graph: {
      "t-1": {
        id: "t-1",
        workflowId: "wf-1",
        title: "Task 1",
        prompt: "do it",
        dependsOn: [],
        executionStatus: "pending",
        stackStatus: "clean",
        priority: 0,
        claims: [],
        contract: { summary: "Task 1", expectedArtifacts: [] },
        artifacts: [],
        runs: [],
        readiness: "unknown",
        version: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    },
    operations: {},
    policy: { maxConcurrent: 3, autoLand: false, autoMergeOnGreen: false },
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeSnapshot(workflows: Workflow[]): ConnectionSnapshot {
  return { workflows };
}

describe("applyEventToSnapshot", () => {
  it("applies task-transitioned to the matching task", () => {
    const snap = makeSnapshot([makeWorkflow()]);
    const event: WorkflowEvent = {
      cursor: 2,
      workflowId: "wf-1",
      occurredAt: "2026-01-01T00:01:00Z",
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

    const result = applyEventToSnapshot(snap, event);
    expect(result.workflows[0]?.graph["t-1"]?.executionStatus).toBe("running");
    expect(result.workflows[0]?.graph["t-1"]?.version).toBe(2);
  });

  it("applies workflow-status-changed", () => {
    const snap = makeSnapshot([makeWorkflow()]);
    const event: WorkflowEvent = {
      cursor: 3,
      workflowId: "wf-1",
      occurredAt: "2026-01-01T00:02:00Z",
      kind: "workflow-status-changed",
      payload: { fromStatus: "active", toStatus: "completed" },
    };

    const result = applyEventToSnapshot(snap, event);
    expect(result.workflows[0]?.status).toBe("completed");
  });

  it("returns same snapshot reference for unknown workflow", () => {
    const snap = makeSnapshot([makeWorkflow()]);
    const event: WorkflowEvent = {
      cursor: 1,
      workflowId: "wf-other",
      occurredAt: "2026-01-01T00:00:00Z",
      kind: "workflow-status-changed",
      payload: { fromStatus: "active", toStatus: "completed" },
    };

    const result = applyEventToSnapshot(snap, event);
    expect(result).toBe(snap);
  });

  it("skips task-transitioned with stale version", () => {
    const snap = makeSnapshot([makeWorkflow()]);
    const task = snap.workflows[0]?.graph["t-1"];
    expect(task?.version).toBe(1);

    const event: WorkflowEvent = {
      cursor: 2,
      workflowId: "wf-1",
      occurredAt: "2026-01-01T00:01:00Z",
      kind: "task-transitioned",
      payload: {
        taskId: "t-1",
        fromExecutionStatus: "pending",
        toExecutionStatus: "running",
        fromStackStatus: "clean",
        toStackStatus: "clean",
        taskVersion: 0,
      },
    };

    const result = applyEventToSnapshot(snap, event);
    expect(result.workflows[0]?.graph["t-1"]?.executionStatus).toBe("pending");
  });

  it("returns same snapshot reference for run-started (streaming only)", () => {
    const snap = makeSnapshot([makeWorkflow()]);
    const event: WorkflowEvent = {
      cursor: 4,
      workflowId: "wf-1",
      occurredAt: "2026-01-01T00:01:00Z",
      kind: "run-started",
      payload: {
        runId: "run-1",
        taskId: "t-1",
        attempt: 1,
        runtimeSessionId: "sess-1",
        providerType: "claude",
        runtimeType: "tmux",
      },
    };

    const result = applyEventToSnapshot(snap, event);
    expect(result).toBe(snap);
  });
});
