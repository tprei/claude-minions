import { describe, it, expect } from "vitest";
import { parseHash } from "../../pwa/assets/app-v1.js";

describe("parseHash", () => {
  it("extracts workflow id from valid hash", () => {
    expect(parseHash("#/workflow/abc")).toBe("abc");
  });

  it("handles alphanumeric ids", () => {
    expect(parseHash("#/workflow/wf-123-xyz")).toBe("wf-123-xyz");
  });

  it("returns null for empty hash", () => {
    expect(parseHash("")).toBeNull();
  });

  it("returns null for wrong route", () => {
    expect(parseHash("#/something-else")).toBeNull();
  });

  it("returns null for bare workflow prefix with no id", () => {
    expect(parseHash("#/workflow/")).toBeNull();
  });

  it("returns null for workflow with nested path", () => {
    expect(parseHash("#/workflow/abc/tasks")).toBeNull();
  });
});
