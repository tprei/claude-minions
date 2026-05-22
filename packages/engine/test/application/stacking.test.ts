import { describe, expect, it } from "vitest";
import { createWorkflow } from "../../src/domain/workflow.js";
import { deriveBranch, stackBaseRef, transitiveDependencies } from "../../src/application/stacking.js";
import type { TaskSpec } from "../../src/domain/types.js";

const WF = "wf-stack";

function workflow(tasks: TaskSpec[]) {
  return createWorkflow(
    { id: WF, kind: "manual-dag", repoId: "fixture-repo", tasks, policy: { maxConcurrent: 3 } },
    () => "2026-05-22T00:00:00.000Z",
  );
}

describe("stackBaseRef", () => {
  it("returns undefined for a task with no dependencies (base on default branch)", () => {
    const wf = workflow([{ id: "A", title: "A", prompt: "a" }]);
    expect(stackBaseRef(wf, "A")).toBeUndefined();
  });

  it("bases a single-dependency task on its dependency's branch", () => {
    const wf = workflow([
      { id: "A", title: "A", prompt: "a" },
      { id: "B", title: "B", prompt: "b", dependsOn: ["A"] },
    ]);
    expect(stackBaseRef(wf, "B")).toBe(deriveBranch(WF, "A"));
  });

  it("bases a linear chain on the immediate parent", () => {
    const wf = workflow([
      { id: "A", title: "A", prompt: "a" },
      { id: "B", title: "B", prompt: "b", dependsOn: ["A"] },
      { id: "C", title: "C", prompt: "c", dependsOn: ["B"] },
    ]);
    expect(stackBaseRef(wf, "C")).toBe(deriveBranch(WF, "B"));
  });

  it("bases a join on the dominating dependency that transitively contains the others", () => {
    // D depends on A and C; C -> B -> A, so C's closure contains A. C dominates.
    const wf = workflow([
      { id: "A", title: "A", prompt: "a" },
      { id: "B", title: "B", prompt: "b", dependsOn: ["A"] },
      { id: "C", title: "C", prompt: "c", dependsOn: ["B"] },
      { id: "D", title: "D", prompt: "d", dependsOn: ["A", "C"] },
    ]);
    expect(stackBaseRef(wf, "D")).toBe(deriveBranch(WF, "C"));
  });

  it("throws unstackable_dependencies for independent parents", () => {
    // D depends on B and C, which are siblings (both depend only on A). Neither
    // dominates the other, so there is no single linearizable base.
    const wf = workflow([
      { id: "A", title: "A", prompt: "a" },
      { id: "B", title: "B", prompt: "b", dependsOn: ["A"] },
      { id: "C", title: "C", prompt: "c", dependsOn: ["A"] },
      { id: "D", title: "D", prompt: "d", dependsOn: ["B", "C"] },
    ]);
    expect(() => stackBaseRef(wf, "D")).toThrow(/independent parents/);
  });
});

describe("transitiveDependencies", () => {
  it("collects all transitive ancestors", () => {
    const wf = workflow([
      { id: "A", title: "A", prompt: "a" },
      { id: "B", title: "B", prompt: "b", dependsOn: ["A"] },
      { id: "C", title: "C", prompt: "c", dependsOn: ["B"] },
    ]);
    expect(transitiveDependencies(wf, "C")).toEqual(new Set(["B", "A"]));
    expect(transitiveDependencies(wf, "A")).toEqual(new Set());
  });
});
