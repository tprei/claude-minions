import { describe, it, expect, beforeEach } from "vitest";
import { useVersionStore, hasVersionConflict } from "../version.js";

const CONN = "conn-1";

describe("useVersionStore", () => {
  beforeEach(() => {
    useVersionStore.setState({ byConnection: new Map() });
  });

  it("setWorkflowVersion stores and getWorkflowVersion retrieves", () => {
    useVersionStore.getState().setWorkflowVersion(CONN, "wf1", 3);
    expect(useVersionStore.getState().getWorkflowVersion(CONN, "wf1")).toBe(3);
  });

  it("getWorkflowVersion returns undefined for unknown workflow", () => {
    expect(useVersionStore.getState().getWorkflowVersion(CONN, "unknown")).toBeUndefined();
  });

  it("seedFromWorkflows bulk-seeds all versions", () => {
    useVersionStore.getState().seedFromWorkflows(CONN, [
      { workflowId: "wf1", version: 2 },
      { workflowId: "wf2", version: 5 },
    ]);
    expect(useVersionStore.getState().getWorkflowVersion(CONN, "wf1")).toBe(2);
    expect(useVersionStore.getState().getWorkflowVersion(CONN, "wf2")).toBe(5);
  });

  it("setWorkflowVersion overwrites a previously seeded version", () => {
    useVersionStore.getState().seedFromWorkflows(CONN, [{ workflowId: "wf1", version: 1 }]);
    useVersionStore.getState().setWorkflowVersion(CONN, "wf1", 4);
    expect(useVersionStore.getState().getWorkflowVersion(CONN, "wf1")).toBe(4);
  });
});

describe("hasVersionConflict", () => {
  beforeEach(() => {
    useVersionStore.setState({ byConnection: new Map() });
  });

  it("returns false when local version equals incoming", () => {
    useVersionStore.getState().setWorkflowVersion(CONN, "wf1", 3);
    expect(hasVersionConflict(CONN, "wf1", 3)).toBe(false);
  });

  it("returns false when local version is behind incoming", () => {
    useVersionStore.getState().setWorkflowVersion(CONN, "wf1", 2);
    expect(hasVersionConflict(CONN, "wf1", 5)).toBe(false);
  });

  it("returns true when local version is ahead of incoming", () => {
    useVersionStore.getState().setWorkflowVersion(CONN, "wf1", 7);
    expect(hasVersionConflict(CONN, "wf1", 3)).toBe(true);
  });

  it("returns false when workflow is not tracked yet", () => {
    expect(hasVersionConflict(CONN, "unknown", 1)).toBe(false);
  });
});
