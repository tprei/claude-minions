import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../src/application/repository.js";
import { TRANSITION_KINDS, type TransitionCommand, type TransitionKind } from "../src/application/transitions.js";
import { createSingleTaskWorkflow } from "../src/domain/workflow.js";
import type { NodeRun } from "../src/domain/runs.js";
import type { TaskExecutionStatus, TaskNode, Workflow } from "../src/domain/types.js";

const now = "2026-05-04T11:19:00.000Z";
const workflowId = "wf-1";
const taskId = "wf-1:task";

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

function openRun(): NodeRun {
  return {
    id: `run-${taskId}-1`,
    taskId,
    attempt: 1,
    providerType: "stub",
    runtimeType: "stub",
    runtimeSessionId: "s1",
    startedAt: now,
  };
}

function workflowWithTask(
  executionStatus: TaskExecutionStatus,
  opts: { runs?: NodeRun[]; sessionId?: string; artifacts?: TaskNode["artifacts"] } = {},
): Workflow {
  const workflow = createSingleTaskWorkflow(workflowId, { title: "T", prompt: "P" }, () => now);
  const task = workflow.graph[taskId]!;
  const nextTask: TaskNode = {
    ...task,
    executionStatus,
    runs: opts.runs ?? [],
    artifacts: opts.artifacts ?? [],
    updatedAt: now,
  };
  if (opts.sessionId !== undefined) nextTask.sessionId = opts.sessionId;
  return {
    ...workflow,
    graph: { ...workflow.graph, [taskId]: nextTask },
  };
}

interface TransitionCase {
  from: TaskExecutionStatus;
  command: Omit<TransitionCommand, "taskId" | "now">;
  expectedTo: TaskExecutionStatus;
  expectTaskTransition: boolean;
  runs?: NodeRun[];
  sessionId?: string;
  artifacts?: TaskNode["artifacts"];
}

const transitionCases: Record<TransitionKind, TransitionCase> = {
  "mark-ready": {
    from: "pending",
    command: { kind: "mark-ready" },
    expectedTo: "ready",
    expectTaskTransition: true,
  },
  "mark-running": {
    from: "ready",
    command: { kind: "mark-running", sessionId: "s1", providerType: "stub", runtimeType: "stub" },
    expectedTo: "running",
    expectTaskTransition: true,
  },
  "update-run": {
    from: "running",
    command: { kind: "update-run", providerSessionRef: "psr-1" },
    expectedTo: "running",
    expectTaskTransition: false,
    runs: [openRun()],
    sessionId: "s1",
  },
  "complete-runtime": {
    from: "running",
    command: { kind: "complete-runtime" },
    expectedTo: "completed",
    expectTaskTransition: true,
    runs: [openRun()],
    sessionId: "s1",
  },
  "start-finalization": {
    from: "completed",
    command: { kind: "start-finalization" },
    expectedTo: "finalizing",
    expectTaskTransition: true,
  },
  "open-review": {
    from: "finalizing",
    command: { kind: "open-review" },
    expectedTo: "pr-open",
    expectTaskTransition: true,
  },
  "start-quality-gate": {
    from: "completed",
    command: { kind: "start-quality-gate" },
    expectedTo: "quality-pending",
    expectTaskTransition: true,
  },
  "complete-quality-gate": {
    from: "quality-pending",
    command: { kind: "complete-quality-gate", passed: true },
    expectedTo: "finalizing",
    expectTaskTransition: true,
  },
  "start-ci-gate": {
    from: "pr-open",
    command: { kind: "start-ci-gate" },
    expectedTo: "ci-pending",
    expectTaskTransition: true,
  },
  "complete-ci-gate": {
    from: "ci-pending",
    command: { kind: "complete-ci-gate" },
    expectedTo: "pr-open",
    expectTaskTransition: true,
  },
  "merge-task": {
    from: "pr-open",
    command: { kind: "merge-task" },
    expectedTo: "merged",
    expectTaskTransition: true,
  },
  "complete-without-pr": {
    from: "finalizing",
    command: { kind: "complete-without-pr" },
    expectedTo: "merged",
    expectTaskTransition: true,
  },
  "merge-conflict": {
    from: "pr-open",
    command: { kind: "merge-conflict" },
    expectedTo: "needs-review",
    expectTaskTransition: true,
  },
  "cancel-task": {
    from: "running",
    command: { kind: "cancel-task" },
    expectedTo: "cancelled",
    expectTaskTransition: true,
    runs: [openRun()],
    sessionId: "s1",
  },
  "recover-task": {
    from: "running",
    command: { kind: "recover-task" },
    expectedTo: "pending",
    expectTaskTransition: true,
    runs: [openRun()],
    sessionId: "s1",
  },
  "mark-interrupted": {
    from: "running",
    command: { kind: "mark-interrupted" },
    expectedTo: "needs-review",
    expectTaskTransition: true,
    runs: [openRun()],
    sessionId: "s1",
  },
  "fail-task": {
    from: "running",
    command: { kind: "fail-task" },
    expectedTo: "failed",
    expectTaskTransition: true,
    runs: [openRun()],
    sessionId: "s1",
  },
};

describe("event derivation", () => {
  it("has a transition contract case for every transition kind", () => {
    expect(Object.keys(transitionCases).sort()).toEqual([...TRANSITION_KINDS].sort());
  });

  it.each(TRANSITION_KINDS)("transition contract: %s", async (kind) => {
    const spec = transitionCases[kind];
    const repo = new InMemoryWorkflowRepository();
    const workflowOpts: { runs?: NodeRun[]; sessionId?: string; artifacts?: TaskNode["artifacts"] } = {};
    if (spec.runs !== undefined) workflowOpts.runs = spec.runs;
    if (spec.sessionId !== undefined) workflowOpts.sessionId = spec.sessionId;
    if (spec.artifacts !== undefined) workflowOpts.artifacts = spec.artifacts;
    const workflow = workflowWithTask(spec.from, workflowOpts);
    const before = workflow.graph[taskId]!;
    await repo.save(workflow, []);

    const result = await applyCommand(repo, {
      kind: "transition-task",
      workflowId,
      transition: { ...spec.command, taskId, now },
    });
    const after = result.workflow.graph[taskId]!;

    expect(after.executionStatus).toBe(spec.expectedTo);
    expect(after.version).toBe(before.version + 1);

    const event = result.events.find((e) => e.kind === "task-transitioned");
    if (spec.expectTaskTransition) {
      expect(event?.payload).toMatchObject({
        taskId,
        transitionKind: kind,
        fromExecutionStatus: spec.from,
        toExecutionStatus: spec.expectedTo,
        taskVersion: after.version,
      });
    } else {
      expect(event).toBeUndefined();
    }
  });

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
