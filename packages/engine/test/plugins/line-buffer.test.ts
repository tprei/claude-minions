import { describe, expect, it } from "vitest";
import { LineBuffer } from "../../src/plugins/line-buffer.js";

describe("LineBuffer", () => {
  it("two chunks with newline mid-second-chunk yields two complete lines, no tail", () => {
    const buf = new LineBuffer();
    const r1 = buf.push(new TextEncoder().encode("hello"));
    expect(r1).toEqual([]);
    const r2 = buf.push(new TextEncoder().encode("\nworld\n"));
    expect(r2).toEqual(["hello", "world"]);
    expect(buf.flush()).toEqual([]);
  });

  it("multi-byte UTF-8 codepoint split across chunk boundary is reassembled", () => {
    const fullBytes = new TextEncoder().encode("café\n");
    const split = 4;
    const chunk1 = fullBytes.slice(0, split);
    const chunk2 = fullBytes.slice(split);
    const buf = new LineBuffer();
    const r1 = buf.push(chunk1);
    expect(r1).toEqual([]);
    const r2 = buf.push(chunk2);
    expect(r2).toHaveLength(1);
    expect(r2[0]).toBe("café");
  });

  it("trailing partial line plus flush emits tail", () => {
    const buf = new LineBuffer();
    const r1 = buf.push(new TextEncoder().encode("line1\npartial"));
    expect(r1).toEqual(["line1"]);
    expect(buf.flush()).toEqual(["partial"]);
  });

  it("chunk with no newlines returns empty array and buffers content", () => {
    const buf = new LineBuffer();
    const r1 = buf.push(new TextEncoder().encode("no-newline-here"));
    expect(r1).toEqual([]);
    expect(buf.flush()).toEqual(["no-newline-here"]);
  });

  it("empty chunk returns empty array", () => {
    const buf = new LineBuffer();
    const r1 = buf.push(new Uint8Array(0));
    expect(r1).toEqual([]);
    expect(buf.flush()).toEqual([]);
  });
});
