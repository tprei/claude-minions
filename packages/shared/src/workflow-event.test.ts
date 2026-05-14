import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WORKFLOW_EVENT_KINDS, type WorkflowEvent } from "./event.js";

const BASE = {
  cursor: 0,
  workflowId: "wf-1",
  occurredAt: "2026-05-14T00:00:00.000Z",
} as const;

const EXAMPLE_EVENTS = [
  {
    ...BASE,
    kind: "task-transitioned",
    payload: {
      taskId: "task-1",
      transitionKind: "mark-ready",
      fromExecutionStatus: "pending",
      toExecutionStatus: "ready",
      fromStackStatus: "clean",
      toStackStatus: "clean",
      taskVersion: 2,
    },
  },
  {
    ...BASE,
    kind: "graph-operation-changed",
    payload: {
      operationId: "op-1",
      kind: "restack",
      fromStatus: null,
      toStatus: "running",
    },
  },
  {
    ...BASE,
    kind: "run-started",
    payload: {
      runId: "run-1",
      taskId: "task-1",
      attempt: 1,
      runtimeSessionId: "runtime-1",
      providerSessionRef: "provider-1",
      providerType: "stub",
      runtimeType: "stub",
    },
  },
  {
    ...BASE,
    kind: "run-ended",
    payload: {
      runId: "run-1",
      taskId: "task-1",
      attempt: 1,
      terminalReason: "completed",
      providerSessionRef: "provider-1",
    },
  },
  {
    ...BASE,
    kind: "workflow-status-changed",
    payload: {
      fromStatus: "active",
      toStatus: "completed",
    },
  },
  {
    ...BASE,
    kind: "provider-event",
    payload: {
      taskId: "task-1",
      runId: "run-1",
      providerEvent: { kind: "assistant_text", text: "done" },
    },
  },
  {
    ...BASE,
    kind: "merge-phase",
    payload: {
      taskId: "task-1",
      phase: "finalize",
      status: "completed",
    },
  },
  {
    ...BASE,
    kind: "ci-poll-result",
    payload: {
      taskId: "task-1",
      runId: "run-1",
      prNumber: 42,
      headSha: "abc123",
      overallStatus: "success",
      checks: [
        {
          name: "ci",
          status: "completed",
          conclusion: "success",
          url: "https://example.invalid/ci",
        },
      ],
    },
  },
] satisfies WorkflowEvent[];

describe("WorkflowEvent contract", () => {
  it("has an example payload for every event kind", () => {
    assert.deepEqual(
      EXAMPLE_EVENTS.map((event) => event.kind).sort(),
      [...WORKFLOW_EVENT_KINDS].sort(),
    );
  });
});
