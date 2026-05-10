import { describe, expect, it } from "vitest";
import { DomainError } from "../src/domain/errors.js";
import { createSingleTaskWorkflow, createWorkflow } from "../src/domain/workflow.js";
import { transitionTask } from "../src/application/transitions.js";

const now = "2026-05-04T11:19:00.000Z";

describe("guarded transitions", () => {
  it("moves a task through ready, running, and completed", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, {
      kind: "complete-runtime",
      taskId: "task-1:task",
      expectedSessionId: "session-1",
      artifacts: [{ kind: "branch", ref: "feature/task-1", producedBy: "task-1:task", createdAt: now }],
      now,
    });

    expect(workflow.graph["task-1:task"]?.executionStatus).toBe("completed");
    expect(workflow.graph["task-1:task"]?.artifacts).toHaveLength(1);
    expect(workflow.status).toBe("completed");
  });

  it("rejects stale task versions", () => {
    const workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);

    expect(() =>
      transitionTask(workflow, {
        kind: "mark-ready",
        taskId: "task-1:task",
        expectedVersion: 2,
        now,
      }),
    ).toThrow(DomainError);
  });

  it("rejects session-bound completion with the wrong session", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });

    expect(() =>
      transitionTask(workflow, {
        kind: "complete-runtime",
        taskId: "task-1:task",
        expectedSessionId: "session-2",
        now,
      }),
    ).toThrow("task session does not match");
  });

  it("complete-runtime preserves sessionId; recover-task clears it", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, {
      kind: "complete-runtime",
      taskId: "task-1:task",
      expectedSessionId: "session-1",
      now,
    });

    expect(workflow.graph["task-1:task"]?.sessionId).toBe("session-1");

    workflow = transitionTask(workflow, { kind: "start-quality-gate", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, { kind: "recover-task", taskId: "task-1:task", now });

    expect(workflow.graph["task-1:task"]?.sessionId).toBeUndefined();
  });
});

describe("recover-task routing", () => {
  it("routes to pending when task has no artifacts", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "recover-task", taskId: "task-1:task", now });

    expect(workflow.graph["task-1:task"]?.executionStatus).toBe("pending");
  });

  it("routes to needs-review when task has artifacts", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, {
      kind: "complete-runtime",
      taskId: "task-1:task",
      artifacts: [{ kind: "branch", ref: "feature/task-1", producedBy: "task-1:task", createdAt: now }],
      now,
    });
    workflow = transitionTask(workflow, { kind: "start-quality-gate", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, { kind: "recover-task", taskId: "task-1:task", now });

    expect(workflow.graph["task-1:task"]?.executionStatus).toBe("needs-review");
    expect(workflow.graph["task-1:task"]?.sessionId).toBeUndefined();
  });
});

describe("quality gate", () => {
  it("routes to finalizing when quality gate passes", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "complete-runtime", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, { kind: "start-quality-gate", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "complete-quality-gate",
      taskId: "task-1:task",
      passed: true,
      now,
    });

    expect(workflow.graph["task-1:task"]?.executionStatus).toBe("finalizing");
  });

  it("routes to needs-review when quality gate fails", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, {
      kind: "complete-runtime",
      taskId: "task-1:task",
      artifacts: [{ kind: "branch", ref: "feature/task-1", producedBy: "task-1:task", createdAt: now }],
      now,
    });
    workflow = transitionTask(workflow, { kind: "start-quality-gate", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "complete-quality-gate",
      taskId: "task-1:task",
      passed: false,
      artifacts: [{ kind: "quality-report", ref: "reports/q1", producedBy: "quality-gate", createdAt: now }],
      now,
    });

    expect(workflow.graph["task-1:task"]?.executionStatus).toBe("needs-review");
    expect(workflow.graph["task-1:task"]?.artifacts).toHaveLength(2);
  });
});

describe("mark-ready", () => {
  it("mark-ready from pending succeeds", () => {
    const workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    const after = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });

    expect(after.graph["task-1:task"]?.executionStatus).toBe("ready");
    expect(after.graph["task-1:task"]?.sessionId).toBeUndefined();
  });

  it("mark-ready from needs-review rejects as invalid_transition", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "mark-interrupted", taskId: "task-1:task", now });
    expect(workflow.graph["task-1:task"]?.executionStatus).toBe("needs-review");

    expect(() =>
      transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now }),
    ).toThrow(DomainError);
  });
});

describe("mark-running from needs-review", () => {
  it("moves needs-review directly to running with sessionId, creates attempt 2", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "mark-interrupted", taskId: "task-1:task", now });
    expect(workflow.graph["task-1:task"]?.executionStatus).toBe("needs-review");

    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-2",
      providerSessionRef: "ref-abc",
      now,
    });

    const task = workflow.graph["task-1:task"]!;
    expect(task.executionStatus).toBe("running");
    expect(task.sessionId).toBe("session-2");
    expect(task.runs).toHaveLength(2);
    expect(task.runs[1]?.attempt).toBe(2);
    expect(task.runs[1]?.providerSessionRef).toBe("ref-abc");
  });

  it("mark-running from needs-review without sessionId throws invalid_transition", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "mark-interrupted", taskId: "task-1:task", now });
    expect(workflow.graph["task-1:task"]?.executionStatus).toBe("needs-review");

    expect(() =>
      transitionTask(workflow, { kind: "mark-running", taskId: "task-1:task", now }),
    ).toThrow(DomainError);
  });
});

describe("mark-running stack-status guard", () => {
  it("rejects when task.stackStatus is restack-pending", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });

    const task = workflow.graph["task-1:task"]!;
    workflow = {
      ...workflow,
      graph: { "task-1:task": { ...task, stackStatus: "restack-pending" } },
    };

    expect(() =>
      transitionTask(workflow, { kind: "mark-running", taskId: "task-1:task", sessionId: "session-1", now }),
    ).toThrow(DomainError);
  });

  it("rejects when task.stackStatus is restacking", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });

    const task = workflow.graph["task-1:task"]!;
    workflow = {
      ...workflow,
      graph: { "task-1:task": { ...task, stackStatus: "restacking" } },
    };

    expect(() =>
      transitionTask(workflow, { kind: "mark-running", taskId: "task-1:task", sessionId: "session-1", now }),
    ).toThrow(DomainError);
  });

  it("rejects when task.stackStatus is restack-conflict", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });

    const task = workflow.graph["task-1:task"]!;
    workflow = {
      ...workflow,
      graph: { "task-1:task": { ...task, stackStatus: "restack-conflict" } },
    };

    expect(() =>
      transitionTask(workflow, { kind: "mark-running", taskId: "task-1:task", sessionId: "session-1", now }),
    ).toThrow(DomainError);
  });
});

describe("mark-running with providerSessionRef", () => {
  it("new run carries providerSessionRef when provided", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      providerSessionRef: "ref-abc",
      now,
    });

    const task = workflow.graph["task-1:task"]!;
    expect(task.runs[0]?.providerSessionRef).toBe("ref-abc");
  });

  it("new run has no providerSessionRef when not provided", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });

    const task = workflow.graph["task-1:task"]!;
    expect(task.runs[0]?.providerSessionRef).toBeUndefined();
  });
});

describe("update-run transition", () => {
  it("patches open run with providerSessionRef and outputOffset; status stays running", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, {
      kind: "update-run",
      taskId: "task-1:task",
      providerSessionRef: "new-ref",
      outputOffset: 42,
      now,
    });

    const task = workflow.graph["task-1:task"]!;
    expect(task.executionStatus).toBe("running");
    expect(task.runs[0]?.providerSessionRef).toBe("new-ref");
    expect(task.runs[0]?.outputOffset).toBe(42);
    expect(task.runs[0]?.endedAt).toBeUndefined();
  });

  it("rejects empty patch (no providerSessionRef, no outputOffset)", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });

    expect(() =>
      transitionTask(workflow, { kind: "update-run", taskId: "task-1:task", now }),
    ).toThrow(DomainError);
  });

  it("rejects update-run from completed status", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "complete-runtime", taskId: "task-1:task", now });

    expect(() =>
      transitionTask(workflow, {
        kind: "update-run",
        taskId: "task-1:task",
        providerSessionRef: "ref",
        now,
      }),
    ).toThrow(DomainError);
  });
});

describe("mark-interrupted transition", () => {
  it("moves a running task to needs-review, clears session, closes run with interrupted", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "mark-interrupted", taskId: "task-1:task", now });

    const task = workflow.graph["task-1:task"]!;
    expect(task.executionStatus).toBe("needs-review");
    expect(task.sessionId).toBeUndefined();
    expect(task.runs[0]?.terminalReason).toBe("interrupted");
    expect(task.runs[0]?.endedAt).toBe(now);
  });

  it("rejects mark-interrupted from a non-running status", () => {
    const workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);

    expect(() =>
      transitionTask(workflow, { kind: "mark-interrupted", taskId: "task-1:task", now }),
    ).toThrow(DomainError);
  });
});

describe("cancel-task from needs-review", () => {
  it("cancels an interrupted task in needs-review", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "mark-interrupted", taskId: "task-1:task", now });
    expect(workflow.graph["task-1:task"]?.executionStatus).toBe("needs-review");

    workflow = transitionTask(workflow, { kind: "cancel-task", taskId: "task-1:task", now });

    expect(workflow.graph["task-1:task"]?.executionStatus).toBe("cancelled");
    expect(workflow.status).toBe("cancelled");
  });
});

describe("workflow status derivation", () => {
  it("returns failed when some tasks failed and others were cancelled", () => {
    const workflow = createWorkflow(
      {
        id: "wf-1",
        kind: "manual-dag",
        tasks: [
          { id: "a", title: "A", prompt: "A" },
          { id: "b", title: "B", prompt: "B" },
        ],
        policy: { maxConcurrent: 2 },
      },
      () => now,
    );

    let next = transitionTask(workflow, { kind: "mark-ready", taskId: "a", now });
    next = transitionTask(next, { kind: "mark-running", taskId: "a", sessionId: "s1", now });
    next = transitionTask(next, { kind: "fail-task", taskId: "a", now });
    next = transitionTask(next, { kind: "cancel-task", taskId: "b", now });

    expect(next.status).toBe("failed");
  });

  it("stays active when the only task is needs-review (interrupted)", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });
    workflow = transitionTask(workflow, { kind: "mark-interrupted", taskId: "task-1:task", now });

    expect(workflow.status).toBe("active");
  });

  it("returns cancelled only when every task is cancelled", () => {
    const workflow = createWorkflow(
      {
        id: "wf-2",
        kind: "manual-dag",
        tasks: [
          { id: "a", title: "A", prompt: "A" },
          { id: "b", title: "B", prompt: "B" },
        ],
        policy: { maxConcurrent: 2 },
      },
      () => now,
    );

    let next = transitionTask(workflow, { kind: "cancel-task", taskId: "a", now });
    next = transitionTask(next, { kind: "cancel-task", taskId: "b", now });

    expect(next.status).toBe("cancelled");
  });
});

describe("merge-conflict transition", () => {
  function reachFinalizing() {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, { kind: "mark-running", taskId: "wf-1:task", sessionId: "s1", now });
    workflow = transitionTask(workflow, { kind: "complete-runtime", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, { kind: "start-finalization", taskId: "wf-1:task", now });
    return workflow;
  }

  function reachPrOpen() {
    let workflow = reachFinalizing();
    workflow = transitionTask(workflow, { kind: "open-review", taskId: "wf-1:task", now });
    return workflow;
  }

  it("transitions from finalizing to needs-review with artifact", () => {
    let workflow = reachFinalizing();
    const artifact = { kind: "patch" as const, ref: '{"phase":"rebase","reason":"conflict"}', producedBy: "merge-service", createdAt: now };
    workflow = transitionTask(workflow, {
      kind: "merge-conflict",
      taskId: "wf-1:task",
      artifacts: [artifact],
      reason: "rebase conflict",
      now,
    });
    expect(workflow.graph["wf-1:task"]?.executionStatus).toBe("needs-review");
    expect(workflow.graph["wf-1:task"]?.artifacts).toHaveLength(1);
    expect(workflow.graph["wf-1:task"]?.artifacts[0]?.kind).toBe("patch");
  });

  it("transitions from pr-open to needs-review with artifact", () => {
    let workflow = reachPrOpen();
    const artifact = { kind: "patch" as const, ref: '{"phase":"applyMerge","reason":"blocked"}', producedBy: "merge-service", createdAt: now };
    workflow = transitionTask(workflow, {
      kind: "merge-conflict",
      taskId: "wf-1:task",
      artifacts: [artifact],
      reason: "blocked",
      now,
    });
    expect(workflow.graph["wf-1:task"]?.executionStatus).toBe("needs-review");
  });

  it("rejects from pending status", () => {
    const workflow = createSingleTaskWorkflow("wf-1", { title: "Task", prompt: "Do it" }, () => now);
    expect(() =>
      transitionTask(workflow, { kind: "merge-conflict", taskId: "wf-1:task", now }),
    ).toThrow(DomainError);
  });

  it("rejects from running status", () => {
    let workflow = createSingleTaskWorkflow("wf-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "wf-1:task", now });
    workflow = transitionTask(workflow, { kind: "mark-running", taskId: "wf-1:task", sessionId: "s1", now });
    expect(() =>
      transitionTask(workflow, { kind: "merge-conflict", taskId: "wf-1:task", now }),
    ).toThrow(DomainError);
  });
});

describe("mark-running workspaceId", () => {
  it("writes workspaceId when provided in command", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      workspaceId: "ws-wf1_task1",
      now,
    });

    expect(workflow.graph["task-1:task"]?.workspaceId).toBe("ws-wf1_task1");
  });

  it("does not write workspaceId when not provided", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      now,
    });

    expect(workflow.graph["task-1:task"]?.workspaceId).toBeUndefined();
  });

  it("terminal transitions do not clear workspaceId", () => {
    let workflow = createSingleTaskWorkflow("task-1", { title: "Task", prompt: "Do it" }, () => now);
    workflow = transitionTask(workflow, { kind: "mark-ready", taskId: "task-1:task", now });
    workflow = transitionTask(workflow, {
      kind: "mark-running",
      taskId: "task-1:task",
      sessionId: "session-1",
      workspaceId: "ws-wf1_task1",
      now,
    });
    workflow = transitionTask(workflow, {
      kind: "complete-runtime",
      taskId: "task-1:task",
      now,
    });

    expect(workflow.graph["task-1:task"]?.workspaceId).toBe("ws-wf1_task1");
  });
});
