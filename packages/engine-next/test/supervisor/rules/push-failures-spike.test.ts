import { describe, expect, it, vi } from "vitest";
import { pushFailuresSpikeRule } from "../../../src/supervisor/rules/push-failures-spike.js";
import { SupervisorState } from "../../../src/supervisor/state.js";
import type { AnomalyRuleContext } from "../../../src/supervisor/rules/index.js";
import type { LogRecord } from "../../../src/observability/types.js";
import { InMemoryWorkflowRepository } from "../../../src/application/repository.js";

function makeCtx(fireAlert: AnomalyRuleContext["fireAlert"] = vi.fn(), nowMs = Date.now()): AnomalyRuleContext {
  return {
    now: () => nowMs,
    fireAlert,
    state: new SupervisorState(),
    workflowRepo: new InMemoryWorkflowRepository(),
  };
}

function makeRecord(kind?: string): LogRecord {
  return { t: new Date().toISOString(), lvl: "error", msg: "push send failed", kind };
}

describe("pushFailuresSpikeRule", () => {
  it("happy path: fires after more than 5 failures in 60s window", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert, 1000);
    for (let i = 0; i <= 5; i++) {
      pushFailuresSpikeRule.onLogRecord!(makeRecord("push-send-failed"), ctx);
    }
    expect(fireAlert).toHaveBeenCalledOnce();
    expect(fireAlert.mock.calls[0]![0].kind).toBe("push-failures-spike");
    expect(fireAlert.mock.calls[0]![0].severity).toBe("warn");
  });

  it("does not fire at exactly 5 failures", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert, 1000);
    for (let i = 0; i < 5; i++) {
      pushFailuresSpikeRule.onLogRecord!(makeRecord("push-send-failed"), ctx);
    }
    expect(fireAlert).not.toHaveBeenCalled();
  });

  it("clears window after alert fires (re-arm)", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert, 1000);
    for (let i = 0; i <= 5; i++) {
      pushFailuresSpikeRule.onLogRecord!(makeRecord("push-send-failed"), ctx);
    }
    expect(ctx.state.pushFailureWindow).toHaveLength(0);
  });

  it("expires old timestamps outside 60s window", () => {
    const fireAlert = vi.fn();
    const baseTime = 100_000;
    const ctx = makeCtx(fireAlert, baseTime);
    for (let i = 0; i < 5; i++) {
      pushFailuresSpikeRule.onLogRecord!(makeRecord("push-send-failed"), ctx);
    }
    ctx.now = () => baseTime + 61_000;
    pushFailuresSpikeRule.onLogRecord!(makeRecord("push-send-failed"), ctx);
    expect(fireAlert).not.toHaveBeenCalled();
    expect(ctx.state.pushFailureWindow).toHaveLength(1);
  });

  it("sabotage: does NOT fire when kind field is absent", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert, 1000);
    for (let i = 0; i <= 5; i++) {
      pushFailuresSpikeRule.onLogRecord!(makeRecord(undefined), ctx);
    }
    expect(fireAlert).not.toHaveBeenCalled();
  });
});
