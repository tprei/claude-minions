import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  checkAdmission,
  classifyMode,
  emptyRunningByClass,
  type RunningByClass,
} from "./admission.js";
import type { RuntimeOverrides } from "@minions/shared";

const RUNTIME: RuntimeOverrides = {
  admissionTotalSlots: 4,
  admissionReservedInteractive: 2,
  admissionLoopCap: 2,
  admissionDagCap: 2,
  admissionBackgroundCap: 1,
};

function counts(partial: Partial<RunningByClass>): RunningByClass {
  return { ...emptyRunningByClass(), ...partial };
}

describe("classifyMode", () => {
  test("task and ship are interactive", () => {
    assert.equal(classifyMode("task"), "interactive");
    assert.equal(classifyMode("ship"), "interactive");
  });

  test("loop is autonomous_loop", () => {
    assert.equal(classifyMode("loop"), "autonomous_loop");
  });

  test("dag-task is dag_task", () => {
    assert.equal(classifyMode("dag-task"), "dag_task");
  });

  test("review and rebase-resolver are background", () => {
    assert.equal(classifyMode("review"), "background");
    assert.equal(classifyMode("rebase-resolver"), "background");
  });
});

describe("checkAdmission", () => {
  test("denies a loop when loops are at cap (loopCap is the binding constraint)", () => {
    const runtime: RuntimeOverrides = {
      admissionTotalSlots: 16,
      admissionReservedInteractive: 2,
      admissionLoopCap: 2,
      admissionDagCap: 8,
      admissionBackgroundCap: 8,
    };
    const decision = checkAdmission(
      "autonomous_loop",
      counts({ autonomous_loop: 2 }),
      runtime,
    );
    assert.equal(decision.admit, false);
    if (!decision.admit) {
      assert.match(decision.reason, /loopCap/);
    }
  });

  test("denies a non-interactive when total - reserved is full", () => {
    const decision = checkAdmission(
      "background",
      counts({ autonomous_loop: 1, dag_task: 1 }),
      RUNTIME,
    );
    assert.equal(decision.admit, false);
    if (!decision.admit) {
      assert.match(decision.reason, /budget|backgroundCap/);
    }
  });

  test("admits an interactive even when total - reserved is full of non-interactive", () => {
    const decision = checkAdmission(
      "interactive",
      counts({ autonomous_loop: 1, dag_task: 1 }),
      RUNTIME,
    );
    assert.equal(decision.admit, true);
  });

  test("admits an interactive up to totalSlots", () => {
    const decision = checkAdmission(
      "interactive",
      counts({ interactive: 3 }),
      RUNTIME,
    );
    assert.equal(decision.admit, true);
  });

  test("denies an interactive at totalSlots", () => {
    const decision = checkAdmission(
      "interactive",
      counts({ interactive: 2, autonomous_loop: 2 }),
      RUNTIME,
    );
    assert.equal(decision.admit, false);
    if (!decision.admit) {
      assert.match(decision.reason, /totalSlots/);
    }
  });

  test("admits a loop while under both caps", () => {
    const decision = checkAdmission(
      "autonomous_loop",
      counts({ interactive: 1, autonomous_loop: 1 }),
      RUNTIME,
    );
    assert.equal(decision.admit, true);
  });

  test("done-when: total=4, reserved=2, loopCap=2 — third loop denied alongside one interactive", () => {
    // First loop admitted.
    let running = counts({ interactive: 1 });
    let decision = checkAdmission("autonomous_loop", running, RUNTIME);
    assert.equal(decision.admit, true);

    // Second loop admitted.
    running = counts({ interactive: 1, autonomous_loop: 1 });
    decision = checkAdmission("autonomous_loop", running, RUNTIME);
    assert.equal(decision.admit, true);

    // Third loop denied.
    running = counts({ interactive: 1, autonomous_loop: 2 });
    decision = checkAdmission("autonomous_loop", running, RUNTIME);
    assert.equal(decision.admit, false);
  });

  test("falls back to defaults when runtime overrides are missing", () => {
    const decision = checkAdmission("interactive", emptyRunningByClass(), {});
    assert.equal(decision.admit, true);
  });

  describe("admissionUnlimited", () => {
    const UNLIMITED: RuntimeOverrides = { ...RUNTIME, admissionUnlimited: true };

    test("admits dag_task even when totalSlots and dagCap would deny", () => {
      const running = counts({
        interactive: 2,
        autonomous_loop: 2,
        dag_task: 2,
        background: 1,
      });
      const decision = checkAdmission("dag_task", running, UNLIMITED);
      assert.equal(decision.admit, true);
    });

    test("admits autonomous_loop past loopCap", () => {
      const running = counts({ autonomous_loop: 99 });
      const decision = checkAdmission("autonomous_loop", running, UNLIMITED);
      assert.equal(decision.admit, true);
    });

    test("admits background past backgroundCap", () => {
      const running = counts({ background: 99 });
      const decision = checkAdmission("background", running, UNLIMITED);
      assert.equal(decision.admit, true);
    });

    test("admits interactive past totalSlots", () => {
      const running = counts({ interactive: 99 });
      const decision = checkAdmission("interactive", running, UNLIMITED);
      assert.equal(decision.admit, true);
    });

    test("preserves cap behaviour when admissionUnlimited is false", () => {
      const explicit: RuntimeOverrides = { ...RUNTIME, admissionUnlimited: false };
      const decision = checkAdmission(
        "autonomous_loop",
        counts({ autonomous_loop: 2 }),
        { ...explicit, admissionLoopCap: 2 },
      );
      assert.equal(decision.admit, false);
    });
  });
});
