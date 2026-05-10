import { describe, expect, it, vi } from "vitest";
import { orchestratorSilentRule } from "../../../src/supervisor/rules/orchestrator-silent.js";
import { SupervisorState } from "../../../src/supervisor/state.js";
import type { AnomalyRuleContext } from "../../../src/supervisor/rules/index.js";
import type { LogRecord } from "../../../src/observability/types.js";
import { InMemoryWorkflowRepository } from "../../../src/application/repository.js";

const SILENCE_MS = 30 * 60 * 1000;

function makeCtx(fireAlert: AnomalyRuleContext["fireAlert"] = vi.fn(), nowMs = Date.now()): AnomalyRuleContext {
  return {
    now: () => nowMs,
    fireAlert,
    state: new SupervisorState(),
    workflowRepo: new InMemoryWorkflowRepository(),
  };
}

function makeRecord(kind: string, workflowId: string, extra?: Record<string, unknown>): LogRecord {
  return { t: new Date().toISOString(), lvl: "info", msg: "event", kind, workflowId, ...extra };
}

describe("orchestratorSilentRule.onLogRecord", () => {
  it("run-started populates activity with hasRunningTask=true and updates lastEventAt", () => {
    const nowMs = 100_000_000;
    const ctx = makeCtx(vi.fn(), nowMs);
    orchestratorSilentRule.onLogRecord!(makeRecord("run-started", "wf-1"), ctx);
    const activity = ctx.state.activity.get("wf-1");
    expect(activity).toBeDefined();
    expect(activity!.hasRunningTask).toBe(true);
    expect(activity!.lastEventAt).toBe(nowMs);
  });

  it("task-transitioned with terminal status flips hasRunningTask to false", () => {
    const nowMs = 100_000_000;
    const ctx = makeCtx(vi.fn(), nowMs);
    orchestratorSilentRule.onLogRecord!(makeRecord("run-started", "wf-1"), ctx);
    orchestratorSilentRule.onLogRecord!(
      makeRecord("task-transitioned", "wf-1", { toExecutionStatus: "completed" }),
      ctx,
    );
    const activity = ctx.state.activity.get("wf-1");
    expect(activity!.hasRunningTask).toBe(false);
  });

  it("task-transitioned with non-terminal status does not flip hasRunningTask", () => {
    const nowMs = 100_000_000;
    const ctx = makeCtx(vi.fn(), nowMs);
    orchestratorSilentRule.onLogRecord!(makeRecord("run-started", "wf-1"), ctx);
    orchestratorSilentRule.onLogRecord!(
      makeRecord("task-transitioned", "wf-1", { toExecutionStatus: "running" }),
      ctx,
    );
    expect(ctx.state.activity.get("wf-1")!.hasRunningTask).toBe(true);
  });

  it("ignores records with no workflowId", () => {
    const ctx = makeCtx();
    const record: LogRecord = { t: new Date().toISOString(), lvl: "info", msg: "x", kind: "run-started" };
    orchestratorSilentRule.onLogRecord!(record, ctx);
    expect(ctx.state.activity.size).toBe(0);
  });

  it("ignores records with irrelevant kind", () => {
    const ctx = makeCtx();
    orchestratorSilentRule.onLogRecord!(makeRecord("push-send-failed", "wf-1"), ctx);
    expect(ctx.state.activity.size).toBe(0);
  });
});

describe("orchestratorSilentRule.onScan", () => {
  it("happy path: fires warn when workflow has running task and is silent for 30+ min", async () => {
    const fireAlert = vi.fn();
    const nowMs = 100_000_000;
    const ctx = makeCtx(fireAlert, nowMs);
    ctx.state.activity.set("wf-1", {
      hasRunningTask: true,
      lastEventAt: nowMs - SILENCE_MS - 1,
      lastAlertAt: 0,
    });
    await orchestratorSilentRule.onScan!(ctx);
    expect(fireAlert).toHaveBeenCalledOnce();
    const alert = fireAlert.mock.calls[0]![0];
    expect(alert.kind).toBe("orchestrator-silent");
    expect(alert.severity).toBe("warn");
    expect(alert.workflowId).toBe("wf-1");
  });

  it("does not fire when workflow has no running task", async () => {
    const fireAlert = vi.fn();
    const nowMs = 100_000_000;
    const ctx = makeCtx(fireAlert, nowMs);
    ctx.state.activity.set("wf-1", {
      hasRunningTask: false,
      lastEventAt: nowMs - SILENCE_MS - 1,
      lastAlertAt: 0,
    });
    await orchestratorSilentRule.onScan!(ctx);
    expect(fireAlert).not.toHaveBeenCalled();
  });

  it("does not fire when last event was recent (< 30 min ago)", async () => {
    const fireAlert = vi.fn();
    const nowMs = 100_000_000;
    const ctx = makeCtx(fireAlert, nowMs);
    ctx.state.activity.set("wf-1", {
      hasRunningTask: true,
      lastEventAt: nowMs - SILENCE_MS + 60_000,
      lastAlertAt: 0,
    });
    await orchestratorSilentRule.onScan!(ctx);
    expect(fireAlert).not.toHaveBeenCalled();
  });

  it("deduplicates: does not fire again within 30 min of last alert", async () => {
    const fireAlert = vi.fn();
    const nowMs = 100_000_000;
    const ctx = makeCtx(fireAlert, nowMs);
    ctx.state.activity.set("wf-1", {
      hasRunningTask: true,
      lastEventAt: nowMs - SILENCE_MS - 1,
      lastAlertAt: nowMs - SILENCE_MS + 60_000,
    });
    await orchestratorSilentRule.onScan!(ctx);
    expect(fireAlert).not.toHaveBeenCalled();
  });

  it("fires correctly with activity populated via onLogRecord", async () => {
    const fireAlert = vi.fn();
    const nowMs = 100_000_000;
    const ctx = makeCtx(fireAlert, nowMs);
    orchestratorSilentRule.onLogRecord!(makeRecord("run-started", "wf-1"), ctx);
    ctx.state.activity.get("wf-1")!.lastEventAt = nowMs - SILENCE_MS - 1;
    await orchestratorSilentRule.onScan!(ctx);
    expect(fireAlert).toHaveBeenCalledOnce();
    expect(fireAlert.mock.calls[0]![0].workflowId).toBe("wf-1");
  });

  it("sabotage: activity map must have hasRunningTask=true for alert to fire", async () => {
    const fireAlert = vi.fn();
    const nowMs = 100_000_000;
    const ctx = makeCtx(fireAlert, nowMs);
    ctx.state.activity.set("wf-1", {
      hasRunningTask: false,
      lastEventAt: nowMs - SILENCE_MS - 1,
      lastAlertAt: 0,
    });
    await orchestratorSilentRule.onScan!(ctx);
    expect(fireAlert).not.toHaveBeenCalled();
  });
});
