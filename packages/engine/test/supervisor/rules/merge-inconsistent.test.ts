import { describe, expect, it, vi } from "vitest";
import { mergeInconsistentRule } from "../../../src/supervisor/rules/merge-inconsistent.js";
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

function makeRecord(overrides: Partial<LogRecord> & { kind?: string } = {}): LogRecord {
  return { t: new Date().toISOString(), lvl: "error", msg: "merge inconsistency", ...overrides };
}

describe("mergeInconsistentRule", () => {
  it("happy path: fires an error alert when kind is merge-inconsistent", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    mergeInconsistentRule.onLogRecord!(
      makeRecord({ kind: "merge-inconsistent", workflowId: "wf-1", taskId: "t-1", sha: "abc123", error: "failed" }),
      ctx,
    );
    expect(fireAlert).toHaveBeenCalledOnce();
    const alert = fireAlert.mock.calls[0]![0];
    expect(alert.kind).toBe("merge-inconsistent");
    expect(alert.severity).toBe("error");
    expect(alert.workflowId).toBe("wf-1");
    expect(alert.taskId).toBe("t-1");
  });

  it("sabotage: does NOT fire when kind field is absent", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    mergeInconsistentRule.onLogRecord!(
      makeRecord({ workflowId: "wf-1" }),
      ctx,
    );
    expect(fireAlert).not.toHaveBeenCalled();
  });

  it("ignores records with a different kind", () => {
    const fireAlert = vi.fn();
    const ctx = makeCtx(fireAlert);
    mergeInconsistentRule.onLogRecord!(
      makeRecord({ kind: "engine-lifecycle" }),
      ctx,
    );
    expect(fireAlert).not.toHaveBeenCalled();
  });
});
