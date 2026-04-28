import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ShipStage } from "@minions/shared";
import { READ_ONLY_STAGES } from "./stages.js";

describe("READ_ONLY_STAGES policy", () => {
  test("contains exactly think and plan", () => {
    assert.ok(READ_ONLY_STAGES.has("think"), "think must be read-only");
    assert.ok(READ_ONLY_STAGES.has("plan"), "plan must be read-only");
    assert.equal(READ_ONLY_STAGES.size, 2, "no other stages in the read-only set");
  });

  test("does NOT contain dag, verify, or done", () => {
    const mutating: ShipStage[] = ["dag", "verify", "done"];
    for (const stage of mutating) {
      assert.ok(
        !READ_ONLY_STAGES.has(stage),
        `${stage} must allow writes (not read-only)`,
      );
    }
  });

  test("write-permission policy: dag transitions allow writes", () => {
    const stage: ShipStage = "dag";
    const allowWrites = !READ_ONLY_STAGES.has(stage);
    assert.equal(allowWrites, true, "transitioning to dag must spawn/resume with allowWriteTools=true");
  });

  test("write-permission policy: think and plan deny writes", () => {
    const thinkAllows = !READ_ONLY_STAGES.has("think");
    const planAllows = !READ_ONLY_STAGES.has("plan");
    assert.equal(thinkAllows, false);
    assert.equal(planAllows, false);
  });
});
