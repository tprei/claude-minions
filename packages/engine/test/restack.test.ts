import { describe, expect, it } from "vitest";
import {
  completeRestackOperation,
  markRestackConflict,
  planRestack,
  requestRestack,
  startRestackOperation,
} from "../src/application/restack.js";
import { createWorkflow } from "../src/domain/workflow.js";
import { completeTask, fixedNow, makeThreeNodeWorkflow } from "../src/testing/builders.js";

describe("restack planning", () => {
  it("orders affected descendants topologically", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");
    workflow = completeTask(workflow, "frontend", "feature/frontend");

    const plan = planRestack(workflow, "backend");

    expect(plan.descendants.map((task) => task.id)).toEqual(["tests"]);
  });

  it("propagates through transitive descendants", () => {
    let workflow = createWorkflow(
      {
        id: "wf-chain",
        kind: "manual-dag",
        tasks: [
          { id: "a", title: "A", prompt: "A" },
          { id: "b", title: "B", prompt: "B", dependsOn: ["a"] },
          { id: "c", title: "C", prompt: "C", dependsOn: ["b"] },
          { id: "d", title: "D", prompt: "D", dependsOn: ["c"] },
        ],
        policy: { maxConcurrent: 1 },
      },
      () => fixedNow,
    );
    workflow = completeTask(workflow, "a", "feature/a");
    workflow = completeTask(workflow, "b", "feature/b");
    workflow = completeTask(workflow, "c", "feature/c");
    workflow = completeTask(workflow, "d", "feature/d");

    ({ workflow } = requestRestack(workflow, {
      operationId: "restack-1",
      ancestorId: "a",
      idempotencyKey: "k1",
      now: fixedNow,
    }));

    expect(workflow.operations["restack-1"]?.affectedNodeIds).toEqual(["b", "c", "d"]);
    expect(workflow.graph.b?.stackStatus).toBe("restack-pending");
    expect(workflow.graph.c?.stackStatus).toBe("restack-pending");
    expect(workflow.graph.d?.stackStatus).toBe("restack-pending");
    expect(workflow.graph.a?.stackStatus).toBe("clean");
  });

  it("persists restack requests before changing stack state", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");
    workflow = completeTask(workflow, "frontend", "feature/frontend");
    ({ workflow } = requestRestack(workflow, {
      operationId: "restack-1",
      ancestorId: "backend",
      idempotencyKey: "restack:backend:main-1",
      fromBase: "main-1",
      toBase: "main-2",
      now: fixedNow,
    }));

    expect(workflow.operations["restack-1"]?.status).toBe("pending");
    expect(workflow.operations["restack-1"]?.affectedNodeIds).toEqual(["tests"]);
    expect(workflow.graph.tests?.executionStatus).toBe("pending");
    expect(workflow.graph.tests?.stackStatus).toBe("restack-pending");
  });

  it("uses idempotency keys to avoid duplicate restack operations", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");
    workflow = completeTask(workflow, "frontend", "feature/frontend");
    ({ workflow } = requestRestack(workflow, {
      operationId: "restack-1",
      ancestorId: "backend",
      idempotencyKey: "restack:backend:main-1",
      now: fixedNow,
    }));
    const { workflow: w2, operation } = requestRestack(workflow, {
      operationId: "restack-2",
      ancestorId: "backend",
      idempotencyKey: "restack:backend:main-1",
      now: fixedNow,
    });

    expect(Object.keys(w2.operations)).toEqual(["restack-1"]);
    expect(operation.id).toBe("restack-1");
  });

  it("keeps execution success separate from restack conflict state", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");
    workflow = completeTask(workflow, "frontend", "feature/frontend");
    workflow = completeTask(workflow, "tests", "feature/tests");
    ({ workflow } = requestRestack(workflow, {
      operationId: "restack-1",
      ancestorId: "backend",
      idempotencyKey: "restack:backend:main-1",
      now: fixedNow,
    }));
    workflow = startRestackOperation(workflow, "restack-1", fixedNow);
    workflow = markRestackConflict(workflow, "restack-1", "conflict in tests", fixedNow);

    expect(workflow.operations["restack-1"]?.status).toBe("conflict");
    expect(workflow.graph.tests?.executionStatus).toBe("completed");
    expect(workflow.graph.tests?.stackStatus).toBe("restack-conflict");
  });

  it("clears stack state after restack success without changing execution success", () => {
    let workflow = makeThreeNodeWorkflow();
    workflow = completeTask(workflow, "backend", "feature/backend");
    workflow = completeTask(workflow, "frontend", "feature/frontend");
    workflow = completeTask(workflow, "tests", "feature/tests");
    ({ workflow } = requestRestack(workflow, {
      operationId: "restack-1",
      ancestorId: "backend",
      idempotencyKey: "restack:backend:main-1",
      now: fixedNow,
    }));
    workflow = startRestackOperation(workflow, "restack-1", fixedNow);
    workflow = completeRestackOperation(workflow, {
      operationId: "restack-1",
      artifactsByTaskId: {
        tests: [{ kind: "branch", ref: "feature/tests-restacked", producedBy: "tests", createdAt: fixedNow }],
      },
      now: fixedNow,
    });

    expect(workflow.operations["restack-1"]?.status).toBe("completed");
    expect(workflow.graph.tests?.executionStatus).toBe("completed");
    expect(workflow.graph.tests?.stackStatus).toBe("clean");
    expect(workflow.graph.tests?.artifacts.map((artifact) => artifact.ref)).toContain(
      "feature/tests-restacked",
    );
  });
});
