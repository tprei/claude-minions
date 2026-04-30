import { describe, it, expect } from "vitest";
import { currentMentionToken, replaceMentionToken } from "../mentions.js";

describe("currentMentionToken", () => {
  it("returns the token when caret sits at the end of @foo", () => {
    const value = "@foo";
    expect(currentMentionToken(value, value.length)).toEqual({
      start: 0,
      end: 4,
      query: "foo",
    });
  });

  it("catches @bar when caret is inside the token in 'hello @bar baz'", () => {
    const value = "hello @bar baz";
    expect(currentMentionToken(value, 9)).toEqual({
      start: 6,
      end: 9,
      query: "ba",
    });
  });

  it("returns null when caret is outside the @token in 'hello @bar baz'", () => {
    const value = "hello @bar baz";
    expect(currentMentionToken(value, 13)).toBeNull();
  });

  it("returns null when there is no @ in the input", () => {
    expect(currentMentionToken("hello world", 5)).toBeNull();
  });

  it("matches @ at the start of the input", () => {
    expect(currentMentionToken("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("matches @foo immediately after a newline", () => {
    const value = "first line\n@foo";
    expect(currentMentionToken(value, value.length)).toEqual({
      start: 11,
      end: 15,
      query: "foo",
    });
  });

  it("returns null when caret is at 0", () => {
    expect(currentMentionToken("@foo", 0)).toBeNull();
  });
});

describe("replaceMentionToken", () => {
  it("splices the replacement plus a trailing space over [start, end)", () => {
    const value = "@fo";
    const result = replaceMentionToken(value, { start: 0, end: 3 }, "@src/foo.ts");
    expect(result.value).toBe("@src/foo.ts ");
    expect(result.caret).toBe("@src/foo.ts ".length);
  });

  it("preserves text before and after the token", () => {
    const value = "see @ba file";
    const result = replaceMentionToken(value, { start: 4, end: 7 }, "@src/bar.ts");
    expect(result.value).toBe("see @src/bar.ts  file");
    expect(result.caret).toBe(4 + "@src/bar.ts".length + 1);
  });
});
