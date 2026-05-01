import { describe, it, expect } from "vitest";
import { slashCommands } from "../slashCommands.js";

describe("slashCommands /execute-plan", () => {
  const cmd = slashCommands.find((c) => c.name === "execute-plan");

  it("is registered", () => {
    expect(cmd).toBeDefined();
  });

  it("returns a ui action when invoked with a session", () => {
    const result = cmd!.build([], { sessionSlug: "think-1" });
    expect(result).toEqual({ kind: "ui", action: "execute-plan" });
  });

  it("throws without an active session", () => {
    expect(() => cmd!.build([], {})).toThrow(/execute-plan/);
  });
});
