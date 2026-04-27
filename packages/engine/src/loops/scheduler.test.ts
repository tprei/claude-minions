import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LoopDefinition } from "@minions/shared";
import { shouldRun, computeBackoff, computeNextRun } from "./scheduler.js";

function makeLoop(overrides: Partial<LoopDefinition> = {}): LoopDefinition {
  const now = new Date().toISOString();
  return {
    id: "test-loop",
    label: "Test loop",
    prompt: "do something",
    intervalSec: 60,
    enabled: true,
    jitterPct: 0,
    maxConcurrent: 1,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("shouldRun", () => {
  it("returns false when loop is disabled", () => {
    const loop = makeLoop({ enabled: false });
    assert.equal(shouldRun(loop, Date.now(), true), false);
  });

  it("returns false when no slots available", () => {
    const loop = makeLoop({ enabled: true });
    assert.equal(shouldRun(loop, Date.now(), false), false);
  });

  it("returns true when nextRunAt is not set", () => {
    const loop = makeLoop({ nextRunAt: undefined });
    assert.equal(shouldRun(loop, Date.now(), true), true);
  });

  it("returns true when nextRunAt is in the past", () => {
    const pastTime = new Date(Date.now() - 10_000).toISOString();
    const loop = makeLoop({ nextRunAt: pastTime });
    assert.equal(shouldRun(loop, Date.now(), true), true);
  });

  it("returns false when nextRunAt is in the future", () => {
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    const loop = makeLoop({ nextRunAt: futureTime });
    assert.equal(shouldRun(loop, Date.now(), true), false);
  });

  it("returns true when nextRunAt equals now", () => {
    const now = Date.now();
    const loop = makeLoop({ nextRunAt: new Date(now).toISOString() });
    assert.equal(shouldRun(loop, now, true), true);
  });
});

describe("computeBackoff", () => {
  it("returns intervalSec when no failures", () => {
    const loop = makeLoop({ intervalSec: 60, consecutiveFailures: 0 });
    assert.equal(computeBackoff(loop), 60);
  });

  it("doubles with each failure", () => {
    const loop = makeLoop({ intervalSec: 60, consecutiveFailures: 1 });
    assert.equal(computeBackoff(loop), 120);
  });

  it("quadruples at 2 failures", () => {
    const loop = makeLoop({ intervalSec: 60, consecutiveFailures: 2 });
    assert.equal(computeBackoff(loop), 240);
  });

  it("caps at 86400 seconds", () => {
    const loop = makeLoop({ intervalSec: 60, consecutiveFailures: 20 });
    assert.equal(computeBackoff(loop), 86400);
  });
});

describe("computeNextRun", () => {
  it("returns a future ISO date based on intervalSec and no failures", () => {
    const loop = makeLoop({ intervalSec: 60, consecutiveFailures: 0 });
    const now = Date.now();
    const result = computeNextRun(loop, now);
    const expected = now + 60 * 1000;
    assert.ok(Math.abs(new Date(result).getTime() - expected) < 100);
  });

  it("applies backoff when there are failures", () => {
    const loop = makeLoop({ intervalSec: 60, consecutiveFailures: 2 });
    const now = Date.now();
    const result = computeNextRun(loop, now);
    const expected = now + 240 * 1000;
    assert.ok(Math.abs(new Date(result).getTime() - expected) < 100);
  });
});
