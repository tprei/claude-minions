import { describe, expect, it } from "vitest";
import { createSingleTaskWorkflow, createThinkThreadWorkflow, createWorkflow } from "../src/domain/workflow.js";

const now = "2026-05-04T11:19:00.000Z";

describe("workflow creation", () => {
  it("represents a normal task as a single-node workflow", () => {
    const workflow = createSingleTaskWorkflow(
      "task-1",
      { title: "Fix bug", prompt: "Fix the bug" },
      () => now,
    );

    expect(workflow.kind).toBe("single-task");
    expect(Object.keys(workflow.graph)).toEqual(["task-1:task"]);
    expect(workflow.policy.maxConcurrent).toBe(1);
  });

  it("represents a think thread as a single-node workflow without a merge target", () => {
    const workflow = createThinkThreadWorkflow(
      "think-1",
      { title: "Think", prompt: "Reason about approach" },
      () => now,
    );

    const task = workflow.graph["think-1:think"];

    expect(workflow.kind).toBe("think-thread");
    expect(task?.mergeTarget).toBeUndefined();
  });

  it("rejects unknown workflow kind", () => {
    expect(() =>
      createWorkflow(
        {
          id: "bad",
          kind: "totally-made-up" as never,
          tasks: [{ id: "t", title: "T", prompt: "P" }],
        },
        () => now,
      ),
    ).toThrow("unknown workflow kind");
  });

  it("rejects cyclic DAGs", () => {
    expect(() =>
      createWorkflow(
        {
          id: "bad",
          kind: "manual-dag",
          tasks: [
            { id: "a", title: "A", prompt: "A", dependsOn: ["b"] },
            { id: "b", title: "B", prompt: "B", dependsOn: ["a"] },
          ],
        },
        () => now,
      ),
    ).toThrow("workflow graph contains a cycle");
  });
});
