import { describe, it, expect } from "vitest";
import { buildActions } from "./CommandPalette.actions.js";

describe("buildActions", () => {
  it("only exposes implemented navigation targets", () => {
    const actions = buildActions({ activeId: "local", sessions: [] });
    const ids = new Set(actions.map((action) => action.id));

    expect(ids.has("nav:list")).toBe(true);
    expect(ids.has("nav:dag")).toBe(true);
    expect(ids.has("nav:new")).toBe(true);

    for (const stale of ["nav:kanban", "nav:ship", "nav:doctor", "drawer:loops", "drawer:variants"]) {
      expect(ids.has(stale), stale).toBe(false);
    }
  });
});
