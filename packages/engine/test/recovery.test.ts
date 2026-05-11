import { describe, expect, it } from "vitest";
import { planRecovery } from "../src/application/recovery.js";
import { requestRestack } from "../src/application/restack.js";
import { transitionTask } from "../src/application/transitions.js";
import { createSingleTaskWorkflow } from "../src/domain/workflow.js";
import { completeTask, makeThreeNodeWorkflow } from "../src/testing/builders.js";

const started = "2026-05-04T11:19:00.000Z";
const later = new Date("2026-05-04T11:21:00.000Z").getTime();

describe("recovery planning", () => {
  it("recovers stale ready tasks", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => started);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now: started });

    const actions = planRecovery(workflow, {
      nowMs: later,
      staleReadyMs: 60_000,
      staleGateMs: 300_000,
    });

    expect(actions).toEqual([
      { kind: "recover-task", taskId: "task-1:task", reason: "stale ready task" },
    ]);
  });

  it("emits recover-task for a running task whose probe is dead", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => started);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now: started });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now: started,
    });

    const actions = planRecovery(workflow, {
      nowMs: later,
      staleReadyMs: 60_000,
      staleGateMs: 300_000,
      runtimeProbes: { "session-1": "dead" },
    });

    expect(actions).toEqual([
      {
        kind: "recover-task",
        taskId: "task-1:task",
        sessionId: "session-1",
        reason: "runtime probe is dead",
      },
    ]);
  });

  it("emits interrupt-task for a running task whose probe is missing", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => started);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now: started });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now: started,
    });

    const actions = planRecovery(workflow, {
      nowMs: later,
      staleReadyMs: 60_000,
      staleGateMs: 300_000,
      runtimeProbes: { "session-1": "missing" },
    });

    expect(actions).toEqual([
      {
        kind: "interrupt-task",
        taskId: "task-1:task",
        sessionId: "session-1",
        reason: "runtime probe is missing",
      },
    ]);
  });

  it("emits stop-runtime for every live session when workflow is cancelled", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => started);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now: started });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now: started,
    });

    const actions = planRecovery(workflow, {
      nowMs: later,
      staleReadyMs: 60_000,
      staleGateMs: 300_000,
      workflowCancelled: true,
    });

    expect(actions).toEqual([
      {
        kind: "stop-runtime",
        taskId: "task-1:task",
        sessionId: "session-1",
        reason: "workflow cancelled with live runtime",
      },
    ]);
  });

  it("resumes pending graph operations on recovery scans", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");
    workflow = completeTask(workflow, "frontend", "feature/frontend");
    ({ workflow } = requestRestack(workflow, {
      operationId: "restack-1",
      ancestorId: "backend",
      idempotencyKey: "restack:backend:main-1",
      now: started,
    }));

    const actions = planRecovery(workflow, {
      nowMs: later,
      staleReadyMs: 60_000,
      staleGateMs: 300_000,
    });

    expect(actions).toContainEqual({
      kind: "resume-graph-operation",
      operationId: "restack-1",
      reason: "restack operation is pending",
    });
  });
});
