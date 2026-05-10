import { describe, expect, it } from "vitest";
import { requestRestack, startRestackOperation, markRestackConflict } from "../src/application/restack.js";
import { planDispatch } from "../src/application/scheduler.js";
import { transitionTask } from "../src/application/transitions.js";
import { createWorkflow } from "../src/domain/workflow.js";
import { completeTask, fixedNow, makeThreeNodeWorkflow } from "../src/testing/builders.js";

describe("dispatch planning", () => {
  it("dispatches independent nodes in parallel", () => {
    const workflow = makeThreeNodeWorkflow();
    const plan = planDispatch(workflow);

    expect(plan.map((candidate) => candidate.task.id)).toEqual(["backend", "frontend"]);
  });

  it("waits for every fan-in dependency", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");

    const plan = planDispatch(workflow);

    expect(plan.map((candidate) => candidate.task.id)).toEqual(["frontend"]);
  });

  it("includes branch artifacts from every fan-in dependency", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");
    workflow = completeTask(workflow, "frontend", "feature/frontend");

    const plan = planDispatch(workflow);

    expect(plan.map((candidate) => candidate.task.id)).toEqual(["tests"]);
    expect(plan[0]?.dependencyArtifacts.map((artifact) => artifact.ref)).toEqual([
      "feature/backend",
      "feature/frontend",
    ]);
  });

  it("does not dispatch overlapping write claims together", () => {
    let workflow = createWorkflow(
      {
        id: "workflow-claims",
        kind: "manual-dag",
        policy: { maxConcurrent: 2 },
        tasks: [
          {
            id: "a",
            title: "A",
            prompt: "A",
            claims: [{ scope: "src/shared/**", mode: "write" }],
          },
          {
            id: "b",
            title: "B",
            prompt: "B",
            claims: [{ scope: "src/shared/button.ts", mode: "write" }],
          },
        ],
      },
      () => fixedNow,
    );

    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "a", now: fixedNow });

    const plan = planDispatch(workflow);

    expect(plan).toHaveLength(0);
  });

  it("leaves downstream nodes unscheduled after a dependency fails", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "backend", now: fixedNow });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "backend",
      sessionId: "backend-session",
      now: fixedNow,
    });
    workflow = transitionTask(workflow, { kind: "fail-task", taskId: "backend", now: fixedNow });

    const plan = planDispatch(workflow);

    expect(plan.map((candidate) => candidate.task.id)).toEqual(["frontend"]);
    expect(workflow.graph.tests?.executionStatus).toBe("pending");
  });

  it("returns empty when workflow is completed", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");
    workflow = completeTask(workflow, "frontend", "feature/frontend");
    workflow = completeTask(workflow, "tests", "feature/tests");

    expect(planDispatch(workflow)).toHaveLength(0);
  });

  it("returns empty when workflow is failed", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "backend", now: fixedNow });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "backend",
      sessionId: "s1",
      now: fixedNow,
    });
    workflow = transitionTask(workflow, { kind: "fail-task", taskId: "backend", now: fixedNow });
    workflow = transitionTask(workflow, { kind: "cancel-task", taskId: "frontend", now: fixedNow });
    workflow = transitionTask(workflow, { kind: "cancel-task", taskId: "tests", now: fixedNow });

    expect(workflow.status).toBe("failed");
    expect(planDispatch(workflow)).toHaveLength(0);
  });

  it("does not dispatch a pending task whose write claims overlap a needs-review task", () => {
    let workflow = createWorkflow(
      {
        id: "wf-needs-review-claims",
        kind: "manual-dag",
        policy: { maxConcurrent: 2 },
        tasks: [
          {
            id: "a",
            title: "A",
            prompt: "A",
            claims: [{ scope: "src/shared/**", mode: "write" }],
          },
          {
            id: "b",
            title: "B",
            prompt: "B",
            claims: [{ scope: "src/shared/button.ts", mode: "write" }],
          },
        ],
      },
      () => fixedNow,
    );

    // Drive task-a to needs-review via the quality gate path.
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "a", now: fixedNow });
    workflow = transitionTask(workflow, { kind: "mark-running", taskId: "a", sessionId: "s1", now: fixedNow });
    workflow = transitionTask(workflow, { kind: "complete-runtime", taskId: "a", now: fixedNow });
    workflow = transitionTask(workflow, { kind: "start-quality-gate", taskId: "a", now: fixedNow });
    workflow = transitionTask(workflow, { kind: "complete-quality-gate", taskId: "a", passed: false, now: fixedNow });

    expect(workflow.graph.a?.executionStatus).toBe("needs-review");

    const plan = planDispatch(workflow);

    expect(plan).toHaveLength(0);
  });

  it("excludes pending tasks with stackStatus restack-pending", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");
    workflow = completeTask(workflow, "frontend", "feature/frontend");
    ({ workflow } = requestRestack(workflow, {
      operationId: "restack-1",
      ancestorId: "backend",
      idempotencyKey: "k1",
      now: fixedNow,
    }));

    expect(workflow.graph.tests?.executionStatus).toBe("pending");
    expect(workflow.graph.tests?.stackStatus).toBe("restack-pending");

    expect(planDispatch(workflow)).toHaveLength(0);
  });

  it("excludes pending tasks with stackStatus restacking", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");
    workflow = completeTask(workflow, "frontend", "feature/frontend");
    ({ workflow } = requestRestack(workflow, {
      operationId: "restack-1",
      ancestorId: "backend",
      idempotencyKey: "k1",
      now: fixedNow,
    }));
    workflow = startRestackOperation(workflow, "restack-1", fixedNow);

    expect(workflow.graph.tests?.executionStatus).toBe("pending");
    expect(workflow.graph.tests?.stackStatus).toBe("restacking");

    expect(planDispatch(workflow)).toHaveLength(0);
  });

  it("excludes pending tasks with stackStatus restack-conflict", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");
    workflow = completeTask(workflow, "frontend", "feature/frontend");
    ({ workflow } = requestRestack(workflow, {
      operationId: "restack-1",
      ancestorId: "backend",
      idempotencyKey: "k1",
      now: fixedNow,
    }));
    workflow = startRestackOperation(workflow, "restack-1", fixedNow);
    workflow = markRestackConflict(workflow, "restack-1", "merge conflict", fixedNow);

    expect(workflow.graph.tests?.executionStatus).toBe("pending");
    expect(workflow.graph.tests?.stackStatus).toBe("restack-conflict");

    expect(planDispatch(workflow)).toHaveLength(0);
  });

  it("excludes pending tasks with stackStatus stale-artifacts", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");
    workflow = completeTask(workflow, "frontend", "feature/frontend");
    const testsTask = workflow.graph.tests;
    if (!testsTask) throw new Error("tests task missing");
    workflow = {
      ...workflow,
      graph: {
        ...workflow.graph,
        tests: { ...testsTask, stackStatus: "stale-artifacts" },
      },
    };

    expect(workflow.graph.tests?.executionStatus).toBe("pending");
    expect(workflow.graph.tests?.stackStatus).toBe("stale-artifacts");

    expect(planDispatch(workflow)).toHaveLength(0);
  });

  it("does not count gate-blocked tasks against runtime concurrency", () => {
    const workflow = createWorkflow(
      {
        id: "wf-gate",
        kind: "manual-dag",
        policy: { maxConcurrent: 1 },
        tasks: [
          { id: "a", title: "A", prompt: "A" },
          { id: "b", title: "B", prompt: "B" },
        ],
      },
      () => fixedNow,
    );

    let next = transitionTask(workflow, { kind: "mark-ready", taskId: "a", now: fixedNow });
    next = transitionTask(next, { kind: "mark-running", taskId: "a", sessionId: "s1", now: fixedNow });
    next = transitionTask(next, { kind: "complete-runtime", taskId: "a", now: fixedNow });
    next = transitionTask(next, { kind: "start-quality-gate", taskId: "a", now: fixedNow });

    const plan = planDispatch(next);

    expect(plan.map((c) => c.task.id)).toEqual(["b"]);
  });
});
