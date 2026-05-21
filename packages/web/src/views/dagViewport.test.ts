import { afterEach, describe, expect, it } from "vitest";
import { clearConnectionViewports, getViewport, setViewport } from "./dagViewport.js";

afterEach(() => {
  globalThis.localStorage.clear();
});

describe("dagViewport", () => {
  it("clears only the persisted viewports for the specified connection", () => {
    setViewport("conn-a", "dag-1", { x: 1, y: 2, scale: 3 });
    setViewport("conn-a", "dag-2", { x: 4, y: 5, scale: 6 });
    setViewport("conn-b", "dag-1", { x: 7, y: 8, scale: 9 });

    clearConnectionViewports("conn-a");

    expect(getViewport("conn-a", "dag-1")).toBeNull();
    expect(getViewport("conn-a", "dag-2")).toBeNull();
    expect(getViewport("conn-b", "dag-1")).toEqual({ x: 7, y: 8, scale: 9 });
  });
});
