import { describe, it, expect } from "vitest";
import { getTaskVisual, isRunning } from "../statusToVisual.js";

describe("getTaskVisual", () => {
  it("returns no badgeLabel when stackStatus is clean", () => {
    const result = getTaskVisual("completed", "clean");
    expect(result.dotClass).toBe("bg-blue-400");
    expect(result.label).toBe("completed");
    expect(result.badgeLabel).toBeUndefined();
  });

  it("returns badgeLabel 'RESTACK PENDING' when stackStatus is restack-pending", () => {
    const result = getTaskVisual("completed", "restack-pending");
    expect(result.dotClass).toBe("bg-blue-400");
    expect(result.label).toBe("completed");
    expect(result.badgeLabel).toBe("RESTACK PENDING");
  });

  it("returns both fields populated when running and restacking", () => {
    const result = getTaskVisual("running", "restacking");
    expect(result.dotClass).toBe("bg-green-400 animate-pulse");
    expect(result.label).toBe("running");
    expect(result.badgeLabel).toBe("RESTACKING");
  });

  it("returns badgeLabel 'CONFLICT' for restack-conflict", () => {
    const result = getTaskVisual("failed", "restack-conflict");
    expect(result.badgeLabel).toBe("CONFLICT");
  });

  it("returns badgeLabel 'STALE' for stale-artifacts", () => {
    const result = getTaskVisual("pending", "stale-artifacts");
    expect(result.badgeLabel).toBe("STALE");
  });
});

describe("isRunning (existing helper)", () => {
  it("returns true for running", () => {
    expect(isRunning("running")).toBe(true);
  });

  it("returns true for ready", () => {
    expect(isRunning("ready")).toBe(true);
  });

  it("returns false for completed", () => {
    expect(isRunning("completed")).toBe(false);
  });
});
