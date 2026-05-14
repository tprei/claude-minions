import { describe, it, expect } from "vitest";
import { TASK_EXECUTION_STATUSES, TASK_STACK_STATUSES } from "@minions/engine";
import { getTaskVisual, isRunning, statusToVisual } from "../statusToVisual.js";

describe("status mapper exhaustiveness", () => {
  it("maps every task execution status", () => {
    for (const status of TASK_EXECUTION_STATUSES) {
      const visual = statusToVisual(status);
      expect(visual.dotClass.length).toBeGreaterThan(0);
      expect(visual.label.length).toBeGreaterThan(0);
    }
  });

  it("maps every stack status with every execution status", () => {
    for (const executionStatus of TASK_EXECUTION_STATUSES) {
      for (const stackStatus of TASK_STACK_STATUSES) {
        const visual = getTaskVisual(executionStatus, stackStatus);
        expect(visual.dotClass.length).toBeGreaterThan(0);
        expect(visual.label.length).toBeGreaterThan(0);
      }
    }
  });
});

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
