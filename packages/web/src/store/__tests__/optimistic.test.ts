import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerIntent, getIntent, clear, setActiveConnIdResolver, type IntentSpec } from "../optimistic.js";

const CONN = "conn-test";

function spec(rollback: () => void = () => {}): IntentSpec {
  return { connId: CONN, description: "do thing", rollback };
}

describe("optimistic intent registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActiveConnIdResolver(() => CONN);
    clear();
  });
  afterEach(() => {
    clear();
    vi.useRealTimers();
  });

  it("registerIntent records an intent retrievable by requestId", () => {
    const handle = registerIntent(spec(), { timeoutMs: 5000 });
    const intent = getIntent(handle.requestId);
    expect(intent).toBeDefined();
    expect(intent?.requestId).toBe(handle.requestId);
    expect(intent?.connId).toBe(CONN);
    expect(typeof intent?.appliedAt).toBe("number");
  });

  it("cancel() removes the intent and prevents the rollback from firing", () => {
    const rollback = vi.fn();
    const handle = registerIntent(spec(rollback), { timeoutMs: 1000 });
    handle.cancel();
    expect(getIntent(handle.requestId)).toBeUndefined();
    vi.advanceTimersByTime(2000);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rollback fires once after the timeout if not cancelled, and the intent is dropped", () => {
    const rollback = vi.fn();
    const handle = registerIntent(spec(rollback), { timeoutMs: 1000 });
    expect(getIntent(handle.requestId)).toBeDefined();

    vi.advanceTimersByTime(999);
    expect(rollback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(getIntent(handle.requestId)).toBeUndefined();
  });

  it("duplicate cancel is a no-op", () => {
    const rollback = vi.fn();
    const handle = registerIntent(spec(rollback), { timeoutMs: 1000 });
    handle.cancel();
    expect(() => handle.cancel()).not.toThrow();
    vi.advanceTimersByTime(2000);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("clear() drops every pending intent without firing rollbacks", () => {
    const rollbackA = vi.fn();
    const rollbackB = vi.fn();
    const a = registerIntent(spec(rollbackA), { timeoutMs: 1000 });
    const b = registerIntent(spec(rollbackB), { timeoutMs: 1000 });
    clear();
    expect(getIntent(a.requestId)).toBeUndefined();
    expect(getIntent(b.requestId)).toBeUndefined();
    vi.advanceTimersByTime(2000);
    expect(rollbackA).not.toHaveBeenCalled();
    expect(rollbackB).not.toHaveBeenCalled();
  });

  it("each registered intent gets a distinct requestId", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const h = registerIntent(spec(), { timeoutMs: 5000 });
      ids.add(h.requestId);
    }
    expect(ids.size).toBe(8);
  });

  it("rollback does NOT fire when activeConnId switched away from the intent's connId", () => {
    const rollback = vi.fn();
    registerIntent(spec(rollback), { timeoutMs: 1000 });
    setActiveConnIdResolver(() => "other-conn");
    vi.advanceTimersByTime(2000);
    expect(rollback).not.toHaveBeenCalled();
  });
});
