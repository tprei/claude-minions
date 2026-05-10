import { describe, expect, it, vi } from "vitest";
import { ciExhaustedRule } from "../../../src/supervisor/rules/ci-exhausted.js";
import { SupervisorState } from "../../../src/supervisor/state.js";
import type { AnomalyRuleContext } from "../../../src/supervisor/rules/index.js";
import type { LogRecord } from "../../../src/observability/types.js";
import { InMemoryWorkflowRepository } from "../../../src/application/repository.js";
import { createWorkflow } from "../../../src/domain/workflow.js";

function makeCtx(fireAlert: AnomalyRuleContext["fireAlert"] = vi.fn()): AnomalyRuleContext {
  return {
    now: () => Date.now(),
    fireAlert,
    state: new SupervisorState(),
    workflowRepo: new InMemoryWorkflowRepository(),
  };
}

function makeCapRecord(taskId?: string, workflowId?: string): LogRecord {
  return {
    t: new Date().toISOString(),
    lvl: "info",
    msg: "ci attempt cap",
    kind: "ci-attempt-cap",
    ...(taskId !== undefined ? { taskId } : {}),
    ...(workflowId !== undefined ? { workflowId } : {}),
  };
}

describe("ciExhaustedRule", () => {
  it("happy path: fires when task with ci-attempt-cap is still in pr-open", async () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    const repo = ctx.workflowRepo as InMemoryWorkflowRepository;

    const wf = createWorkflow({ id: "wf-1", kind: "single-task", tasks: [{ id: "t-1", title: "task", prompt: "do thing" }] });
    const taskNode = wf.graph["t-1"]!;
    const updatedTask = { ...taskNode, executionStatus: "pr-open" as const };
    const updatedWf = { ...wf, graph: { ...wf.graph, "t-1": updatedTask } };
    await repo.save(updatedWf, []);

    ciExhaustedRule.onLogRecord!(makeCapRecord("t-1", "wf-1"), ctx);
    await ciExhaustedRule.onScan!(ctx);

    expect(fireAlert).toHaveBeenCalledOnce();
    const alert = fireAlert.mock.calls[0]![0];
    expect(alert.kind).toBe("ci-exhausted");
    expect(alert.severity).toBe("error");
    expect(alert.taskId).toBe("t-1");
    expect(alert.workflowId).toBe("wf-1");
  });

  it("does not fire when task is no longer in pr-open", async () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    const repo = ctx.workflowRepo as InMemoryWorkflowRepository;

    const wf = createWorkflow({ id: "wf-1", kind: "single-task", tasks: [{ id: "t-1", title: "task", prompt: "do thing" }] });
    await repo.save(wf, []);

    ciExhaustedRule.onLogRecord!(makeCapRecord("t-1", "wf-1"), ctx);
    await ciExhaustedRule.onScan!(ctx);

    expect(fireAlert).not.toHaveBeenCalled();
  });

  it("does not fire twice for the same task (alerted flag)", async () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    const repo = ctx.workflowRepo as InMemoryWorkflowRepository;

    const wf = createWorkflow({ id: "wf-1", kind: "single-task", tasks: [{ id: "t-1", title: "task", prompt: "do thing" }] });
    const taskNode = wf.graph["t-1"]!;
    const updatedTask = { ...taskNode, executionStatus: "pr-open" as const };
    const updatedWf = { ...wf, graph: { ...wf.graph, "t-1": updatedTask } };
    await repo.save(updatedWf, []);

    ciExhaustedRule.onLogRecord!(makeCapRecord("t-1", "wf-1"), ctx);
    await ciExhaustedRule.onScan!(ctx);
    await ciExhaustedRule.onScan!(ctx);

    expect(fireAlert).toHaveBeenCalledOnce();
  });

  it("wfId+taskId keying: same taskId in different workflows does not cross-contaminate", async () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    const repo = ctx.workflowRepo as InMemoryWorkflowRepository;

    const wf1 = createWorkflow({ id: "wf-1", kind: "single-task", tasks: [{ id: "build", title: "build", prompt: "build" }] });
    const wf2 = createWorkflow({ id: "wf-2", kind: "single-task", tasks: [{ id: "build", title: "build", prompt: "build" }] });
    const taskNodeWf2 = wf2.graph["build"]!;
    const updatedWf2 = { ...wf2, graph: { ...wf2.graph, build: { ...taskNodeWf2, executionStatus: "pr-open" as const } } };
    await repo.save(wf1, []);
    await repo.save(updatedWf2, []);

    ciExhaustedRule.onLogRecord!(makeCapRecord("build", "wf-2"), ctx);
    await ciExhaustedRule.onScan!(ctx);

    expect(fireAlert).toHaveBeenCalledOnce();
    expect(fireAlert.mock.calls[0]![0].workflowId).toBe("wf-2");
    expect(fireAlert.mock.calls[0]![0].taskId).toBe("build");
  });

  it("sabotage: does NOT record task when kind field is absent", async () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    const repo = ctx.workflowRepo as InMemoryWorkflowRepository;

    const wf = createWorkflow({ id: "wf-1", kind: "single-task", tasks: [{ id: "t-1", title: "task", prompt: "do thing" }] });
    const taskNode = wf.graph["t-1"]!;
    const updatedTask = { ...taskNode, executionStatus: "pr-open" as const };
    const updatedWf = { ...wf, graph: { ...wf.graph, "t-1": updatedTask } };
    await repo.save(updatedWf, []);

    const recordWithoutKind: LogRecord = {
      t: new Date().toISOString(),
      lvl: "info",
      msg: "ci attempt cap",
      taskId: "t-1",
      workflowId: "wf-1",
    };
    ciExhaustedRule.onLogRecord!(recordWithoutKind, ctx);
    await ciExhaustedRule.onScan!(ctx);

    expect(fireAlert).not.toHaveBeenCalled();
  });

  it("ignores onLogRecord records with no taskId", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    ciExhaustedRule.onLogRecord!(makeCapRecord(undefined, "wf-1"), ctx);
    expect(ctx.state.pendingCiExhaustion.size).toBe(0);
  });

  it("ignores onLogRecord records with no workflowId", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    ciExhaustedRule.onLogRecord!(makeCapRecord("t-1"), ctx);
    expect(ctx.state.pendingCiExhaustion.size).toBe(0);
  });
});
