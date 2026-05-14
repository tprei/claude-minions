import { afterEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "./store.js";
import { del as idbDel } from "idb-keyval";

vi.mock("idb-keyval", () => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));

afterEach(() => {
  useConnectionStore.setState({ connections: [], activeId: null, _hydrated: false });
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
  });
});
