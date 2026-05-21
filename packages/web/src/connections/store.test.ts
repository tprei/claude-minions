import { afterEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "./store.js";
import { del as idbDel } from "idb-keyval";
import { useWorkflowStore } from "../store/workflowStore.js";
import { useVersionStore } from "../store/version.js";
import { getViewport, setViewport } from "../views/dagViewport.js";

vi.mock("idb-keyval", () => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));

afterEach(() => {
  useConnectionStore.setState({ connections: [], activeId: null, _hydrated: false });
  useWorkflowStore.setState({ byConnection: new Map() });
  useVersionStore.setState({ byConnection: new Map(), workflowVersions: new Map() });
  globalThis.localStorage.clear();
  vi.clearAllMocks();
});

describe("useConnectionStore", () => {
  it("adds, updates, activates, and removes connections", () => {
    const created = useConnectionStore.getState().add({
      label: "Local",
      baseUrl: "http://localhost:3000",
      token: "token",
      color: "#34d399",
    });

    useWorkflowStore.getState().replaceAll(created.id, []);
    useVersionStore.getState().setVersion(created.id, {
      apiVersion: "1.0",
      libraryVersion: "0.1.0",
      buildSha: "sha",
      provider: "stub",
      providers: ["stub"],
      features: [],
      featuresPending: [],
      repos: [],
      pluginSet: [],
      startedAt: "2026-05-20T00:00:00.000Z",
    });
    useVersionStore.getState().setWorkflowVersion(created.id, "wf-1", 1);

    useConnectionStore.getState().setActive(created.id);
    useConnectionStore.getState().update(created.id, { label: "Renamed" });

    expect(useConnectionStore.getState().activeId).toBe(created.id);
    expect(useConnectionStore.getState().connections[0]).toMatchObject({
      id: created.id,
      label: "Renamed",
    });

    useConnectionStore.getState().remove(created.id);

    expect(useConnectionStore.getState().connections).toEqual([]);
    expect(useConnectionStore.getState().activeId).toBeNull();
    expect(idbDel).toHaveBeenCalledWith(`snap:${created.id}`);
    expect(useWorkflowStore.getState().byConnection.has(created.id)).toBe(false);
    expect(useVersionStore.getState().byConnection.has(created.id)).toBe(false);
    expect(useVersionStore.getState().workflowVersions.has(created.id)).toBe(false);
  });

  it("clears persisted DAG viewport state when removing a connection", () => {
    const created = useConnectionStore.getState().add({
      label: "Local",
      baseUrl: "http://localhost:3000",
      token: "token",
      color: "#34d399",
    });

    setViewport(created.id, "wf-1", { x: 1, y: 2, scale: 3 });
    setViewport("other-conn", "wf-1", { x: 4, y: 5, scale: 6 });

    useConnectionStore.getState().remove(created.id);

    expect(getViewport(created.id, "wf-1")).toBeNull();
    expect(getViewport("other-conn", "wf-1")).toEqual({ x: 4, y: 5, scale: 6 });
  });
});
