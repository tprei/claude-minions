import { describe, expect, it } from "vitest";
import { transitionTask } from "../src/application/transitions.js";
import { getOpenRun, patchOpenRun } from "../src/domain/runs.js";
import type { NodeRun } from "../src/domain/runs.js";
import { createSingleTaskWorkflow } from "../src/domain/workflow.js";

const now = "2026-05-04T11:19:00.000Z";
const later = "2026-05-04T11:20:00.000Z";

function makeRun(id: string, open: boolean): NodeRun {
  const base: NodeRun = {
    id,
    taskId: "t",
    attempt: 1,
    providerType: "stub",
    runtimeType: "stub",
    runtimeSessionId: "s",
    startedAt: now,
  };
  if (!open) {
    return { ...base, endedAt: now, terminalReason: "completed" };
  }
  return base;
}

describe("getOpenRun", () => {
  it("returns undefined for empty array", () => {
    expect(getOpenRun([])).toBeUndefined();
  });

  it("returns undefined when all runs are closed", () => {
    expect(getOpenRun([makeRun("r1", false), makeRun("r2", false)])).toBeUndefined();
  });

  it("returns the last run when it is open", () => {
    const open = makeRun("r2", true);
    expect(getOpenRun([makeRun("r1", false), open])).toBe(open);
  });

  it("returns the open run when a later run is closed (walks from end)", () => {
    const open = makeRun("r2", true);
    const closed = makeRun("r3", false);
    expect(getOpenRun([makeRun("r1", false), open, closed])).toBe(open);
  });
});

describe("NodeRun lifecycle", () => {
  it("appends a run on mark-running", () => {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "wf-1:task",
      sessionId: "s1",
      now,
    });

    const task = workflow.graph["wf-1:task"]!;
    expect(task.runs).toHaveLength(1);
    expect(task.runs[0]?.attempt).toBe(1);
    expect(task.runs[0]?.runtimeSessionId).toBe("s1");
    expect(task.runs[0]?.endedAt).toBeUndefined();
    expect(task.runs[0]?.id).toBe("run-wf-1:task-1");
  });

  it("closes a run with terminalReason 'completed' on complete-runtime", () => {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "wf-1:task",
      sessionId: "s1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "complete-runtime", taskId: "wf-1:task", now: later });

    const run = workflow.graph["wf-1:task"]!.runs[0]!;
    expect(run.terminalReason).toBe("completed");
    expect(run.endedAt).toBe(later);
  });

  it("closes a run with terminalReason 'cancelled' on cancel-task", () => {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "wf-1:task",
      sessionId: "s1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "cancel-task", taskId: "wf-1:task", now: later });

    const run = workflow.graph["wf-1:task"]!.runs[0]!;
    expect(run.terminalReason).toBe("cancelled");
    expect(run.endedAt).toBe(later);
  });

  it("closes a run with terminalReason 'failed' on fail-task", () => {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "wf-1:task",
      sessionId: "s1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "fail-task", taskId: "wf-1:task", now: later });

    const run = workflow.graph["wf-1:task"]!.runs[0]!;
    expect(run.terminalReason).toBe("failed");
    expect(run.endedAt).toBe(later);
  });

  it("closes a run with terminalReason 'recovered' on recover-task", () => {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "wf-1:task",
      sessionId: "s1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "recover-task", taskId: "wf-1:task", now: later });

    const run = workflow.graph["wf-1:task"]!.runs[0]!;
    expect(run.terminalReason).toBe("recovered");
    expect(run.endedAt).toBe(later);
  });

  it("produces a second run with attempt 2 after recover-task and mark-running", () => {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "wf-1:task",
      sessionId: "s1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "recover-task", taskId: "wf-1:task", now: later });
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now: later });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "wf-1:task",
      sessionId: "s2",
      now: later,
    });

    const task = workflow.graph["wf-1:task"]!;
    expect(task.runs).toHaveLength(2);
    expect(task.runs[1]?.attempt).toBe(2);
    expect(task.runs[1]?.runtimeSessionId).toBe("s2");
    expect(task.runs[1]?.id).toBe("run-wf-1:task-2");
    expect(task.runs[1]?.endedAt).toBeUndefined();
  });

  it("cancel-task on a pending task leaves runs empty", () => {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    workflow = transitionTask(workflow, { kind: "cancel-task", taskId: "wf-1:task", now });

    expect(workflow.graph["wf-1:task"]!.runs).toHaveLength(0);
  });

  it("patchOpenRun patches the open run and leaves closed runs untouched", () => {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "wf-1:task",
      sessionId: "s1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "complete-runtime", taskId: "wf-1:task", now: later });
    workflow = transitionTask(workflow, { kind: "start-quality-gate", taskId: "wf-1:task", now: later });
    workflow = transitionTask(workflow, { kind: "recover-task", taskId: "wf-1:task", now: later });
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now: later });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "wf-1:task",
      sessionId: "s2",
      now: later,
    });

    const task = workflow.graph["wf-1:task"]!;
    expect(task.runs).toHaveLength(2);

    const patched = patchOpenRun(task.runs, { providerSessionRef: "ref-new", outputOffset: 77 });

    expect(patched[0]?.providerSessionRef).toBeUndefined();
    expect(patched[1]?.providerSessionRef).toBe("ref-new");
    expect(patched[1]?.outputOffset).toBe(77);
    expect(patched[1]?.endedAt).toBeUndefined();
  });

  it("patchOpenRun throws when no open run", () => {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "wf-1:task",
      sessionId: "s1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "complete-runtime", taskId: "wf-1:task", now: later });

    const task = workflow.graph["wf-1:task"]!;
    expect(() => patchOpenRun(task.runs, { outputOffset: 10 })).toThrow("no open run to patch");
  });

  it("closeLatestRun after patchOpenRun preserves patched fields", () => {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "wf-1:task",
      sessionId: "s1",
      now,
    });

    workflow = transitionTask(workflow, {
      kind: "update-run",
      taskId: "wf-1:task",
      providerSessionRef: "patched-ref",
      outputOffset: 55,
      now,
    });

    workflow = transitionTask(workflow, { kind: "complete-runtime", taskId: "wf-1:task", now: later });

    const run = workflow.graph["wf-1:task"]!.runs[0]!;
    expect(run.providerSessionRef).toBe("patched-ref");
    expect(run.outputOffset).toBe(55);
    expect(run.terminalReason).toBe("completed");
    expect(run.endedAt).toBe(later);
  });

  it("closing a run preserves providerSessionRef and outputOffset", () => {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "wf-1:task",
      sessionId: "s1",
      now,
    });

    const task = workflow.graph["wf-1:task"]!;
    const runWithExtra = {
      ...task.runs[0]!,
      providerSessionRef: "psr-abc",
      outputOffset: 42,
    };
    const wfWithExtra = {
      ...workflow,
      graph: {
        ...workflow.graph,
        "wf-1:task": { ...task, runs: [runWithExtra] },
      },
    };

    const closed = transitionTask(wfWithExtra, { kind: "complete-runtime", taskId: "wf-1:task", now: later });
    const closedRun = closed.graph["wf-1:task"]!.runs[0]!;
    expect(closedRun.providerSessionRef).toBe("psr-abc");
    expect(closedRun.outputOffset).toBe(42);
    expect(closedRun.terminalReason).toBe("completed");
  });
});
