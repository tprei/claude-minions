import { describe, it, expect } from "vitest";
import { highlight } from "../highlight.js";

describe("highlight", () => {
  it("returns escaped, non-throwing output for an unknown explicit language", () => {
    const out = highlight("a < b && b > c", "totally-fake-lang");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("returns hljs token spans for json", () => {
    const out = highlight('{ "k": 1 }', "json");
    expect(out).toContain("hljs-attr");
  });

  it("treats ts as typescript via alias", () => {
    const out = highlight("const x: number = 1;", "ts");
    expect(out).toContain("hljs-keyword");
  });

  it("falls back to auto-detect when lang is undefined", () => {
    const out = highlight("function foo() { return 1; }");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});
