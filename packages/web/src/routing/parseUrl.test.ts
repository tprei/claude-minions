import { describe, it, expect, beforeEach } from "vitest";
import { parseUrl } from "./parseUrl.js";

function setLocation(path: string): void {
  window.history.replaceState(null, "", path);
}

describe("parseUrl", () => {
  beforeEach(() => {
    setLocation("/");
  });

  it("returns view=list for the root path", () => {
    setLocation("/");
    const result = parseUrl();
    expect(result).toEqual({
      connectionId: null,
      view: "list",
      sessionSlug: undefined,
      query: {},
    });
  });

  it.each([
    ["/doctor", "doctor"],
    ["/dag", "dag"],
    ["/ship", "ship"],
    ["/kanban", "kanban"],
    ["/loops", "loops"],
    ["/memory", "memory"],
    ["/new", "new"],
  ] as const)("recognizes bare %s as view=%s", (path, view) => {
    setLocation(path);
    const result = parseUrl();
    expect(result.connectionId).toBeNull();
    expect(result.view).toBe(view);
    expect(result.sessionSlug).toBeUndefined();
  });

  it("treats an unknown first segment as a session slug under view=list", () => {
    setLocation("/unknown-segment");
    const result = parseUrl();
    expect(result.connectionId).toBeNull();
    expect(result.view).toBe("list");
    expect(result.sessionSlug).toBe("unknown-segment");
  });

  it("parses a session slug after a known view", () => {
    setLocation("/dag/my-session");
    const result = parseUrl();
    expect(result.connectionId).toBeNull();
    expect(result.view).toBe("dag");
    expect(result.sessionSlug).toBe("my-session");
  });

  it("parses query params", () => {
    setLocation("/doctor?foo=bar&baz=qux");
    const result = parseUrl();
    expect(result.view).toBe("doctor");
    expect(result.query).toEqual({ foo: "bar", baz: "qux" });
  });

  it("still parses the /c/<conn>/<view> shape", () => {
    setLocation("/c/conn-123/dag/session-abc");
    const result = parseUrl();
    expect(result).toEqual({
      connectionId: "conn-123",
      view: "dag",
      sessionSlug: "session-abc",
      query: {},
    });
  });

  it("falls back to view=list when the /c/<conn>/<view> view is unknown", () => {
    setLocation("/c/conn-123/bogus");
    const result = parseUrl();
    expect(result.connectionId).toBe("conn-123");
    expect(result.view).toBe("list");
  });
});
