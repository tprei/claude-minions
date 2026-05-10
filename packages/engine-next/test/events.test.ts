import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../src/application/repository.js";
import { createSingleTaskWorkflow } from "../src/domain/workflow.js";

const now = "2026-05-04T11:19:00.000Z";

function makeRepo(workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now)) {
  const repo = new InMemoryWorkflowRepository();
  return {
    repo,
    async seed() {
      await repo.save(workflow, []);
      return workflow;
    },
  };
}

describe("event derivation", () => {
  it("mark-ready produces a task-transitioned event", async () => {
    const { repo, seed } = makeRepo();
    await seed();

    const result = await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now },
    });

    const transitioned = result.events.filter((e) => e.kind === "task-transitioned");
    expect(transitioned).toHaveLength(1);
    expect(transitioned[0]?.payload.transitionKind).toBe("mark-ready");
    expect(transitioned[0]?.payload.fromExecutionStatus).toBe("pending");
    expect(transitioned[0]?.payload.toExecutionStatus).toBe("ready");
  });

  it("mark-running produces task-transitioned and run-started events", async () => {
    const { repo, seed } = makeRepo();
    await seed();
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now },
    });

    const result = await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s1", now },
    });

    expect(result.events.some((e) => e.kind === "task-transitioned")).toBe(true);
    const runStarted = result.events.find((e) => e.kind === "run-started");
    expect(runStarted).toBeDefined();
    expect(runStarted?.payload.runtimeSessionId).toBe("s1");
    expect(runStarted?.payload.attempt).toBe(1);
  });

  it("complete-runtime produces task-transitioned and run-ended events", async () => {
    const { repo, seed } = makeRepo();
    await seed();
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s1", now },
    });

    const result = await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "complete-runtime", taskId: "wf-1:task", now },
    });

    expect(result.events.some((e) => e.kind === "task-transitioned")).toBe(true);
    const runEnded = result.events.find((e) => e.kind === "run-ended");
    expect(runEnded).toBeDefined();
    expect(runEnded?.payload.terminalReason).toBe("completed");
  });

  it("request-restack produces graph-operation-changed and task-transitioned events", async () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    const repo = new InMemoryWorkflowRepository();
    await repo.save(workflow, []);

    const result = await applyCommand(repo, {
      kind: "request-restack",
      workflowId: "wf-1",
      input: {
        operationId: "op-1",
        ancestorId: "wf-1:task",
        idempotencyKey: "key-1",
        now,
      },
    });

    expect(result.events.some((e) => e.kind === "graph-operation-changed")).toBe(true);
  });

  it("run-ended payload carries providerSessionRef when set on the run", async () => {
    const { repo, seed } = makeRepo();
    await seed();
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s1", now },
    });

    const wf = await repo.get("wf-1");
    const task = wf!.graph["wf-1:task"]!;
    const runWithRef = { ...task.runs[0]!, providerSessionRef: "psr-xyz" };
    const wfWithRef = {
      ...wf!,
      version: wf!.version + 1,
      graph: { ...wf!.graph, "wf-1:task": { ...task, runs: [runWithRef] } },
    };
    await repo.save(wfWithRef, []);

    const result = await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "complete-runtime", taskId: "wf-1:task", now },
    });

    const runEnded = result.events.find((e) => e.kind === "run-ended");
    expect(runEnded?.payload.providerSessionRef).toBe("psr-xyz");
  });

  it("completing the only task produces workflow-status-changed", async () => {
    const { repo, seed } = makeRepo();
    await seed();
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s1", now },
    });

    const result = await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "complete-runtime", taskId: "wf-1:task", now },
    });

    const statusChanged = result.events.find((e) => e.kind === "workflow-status-changed");
    expect(statusChanged).toBeDefined();
    expect(statusChanged?.payload.fromStatus).toBe("active");
    expect(statusChanged?.payload.toStatus).toBe("completed");
  });
});
