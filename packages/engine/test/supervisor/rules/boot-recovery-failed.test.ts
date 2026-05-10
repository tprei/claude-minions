import { describe, expect, it, vi } from "vitest";
import { bootRecoveryFailedRule } from "../../../src/supervisor/rules/boot-recovery-failed.js";
import { SupervisorState } from "../../../src/supervisor/state.js";
import type { AnomalyRuleContext } from "../../../src/supervisor/rules/index.js";
import type { LogRecord } from "../../../src/observability/types.js";
import { InMemoryWorkflowRepository } from "../../../src/application/repository.js";

function makeCtx(fireAlert: AnomalyRuleContext["fireAlert"] = vi.fn()): AnomalyRuleContext {
  return {
    now: () => Date.now(),
    fireAlert,
    state: new SupervisorState(),
    workflowRepo: new InMemoryWorkflowRepository(),
  };
}

function makeRecord(overrides: Record<string, unknown> = {}): LogRecord {
  return {
    t: new Date().toISOString(),
    lvl: "info",
    msg: "boot complete",
    kind: "engine-lifecycle",
    phase: "boot-complete",
    report: { failures: ["wf-1"] },
    ...overrides,
  };
}

describe("bootRecoveryFailedRule", () => {
  it("happy path: fires when boot report has failures", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    bootRecoveryFailedRule.onLogRecord!(makeRecord(), ctx);
    expect(fireAlert).toHaveBeenCalledOnce();
    const alert = fireAlert.mock.calls[0]![0];
    expect(alert.kind).toBe("boot-recovery-failed");
    expect(alert.severity).toBe("error");
    expect(alert.detail?.failures).toEqual(["wf-1"]);
  });

  it("does not fire when failures array is empty", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    bootRecoveryFailedRule.onLogRecord!(makeRecord({ report: { failures: [] } }), ctx);
    expect(fireAlert).not.toHaveBeenCalled();
  });

  it("does not fire when phase is not boot-complete", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    bootRecoveryFailedRule.onLogRecord!(makeRecord({ phase: "started" }), ctx);
    expect(fireAlert).not.toHaveBeenCalled();
  });

  it("sabotage: does NOT fire when kind field is absent", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    const record: LogRecord = {
      t: new Date().toISOString(),
      lvl: "info",
      msg: "boot complete",
      phase: "boot-complete",
      report: { failures: ["wf-1"] },
    };
    bootRecoveryFailedRule.onLogRecord!(record, ctx);
    expect(fireAlert).not.toHaveBeenCalled();
  });

  it("does not fire for non-engine-lifecycle kind", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    bootRecoveryFailedRule.onLogRecord!(makeRecord({ kind: "service-attached" }), ctx);
    expect(fireAlert).not.toHaveBeenCalled();
  });

  it("does not fire when report is null", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    bootRecoveryFailedRule.onLogRecord!(makeRecord({ report: null }), ctx);
    expect(fireAlert).not.toHaveBeenCalled();
  });
});
