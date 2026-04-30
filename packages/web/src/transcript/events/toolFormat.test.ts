import { describe, it, expect } from "vitest";
import type { ToolResultEvent } from "@minions/shared";
import {
  formatInlineArg,
  formatResultSummary,
  singleLine,
  stripWorktree,
} from "./toolFormat.js";

function makeResult(
  partial: Partial<ToolResultEvent> & { status: ToolResultEvent["status"] },
): ToolResultEvent {
  return {
    kind: "tool_result",
    timestamp: "2026-01-01T00:00:00.000Z",
    toolCallId: "tc_1",
    format: "text",
    body: "",
    ...partial,
  } as ToolResultEvent;
}

describe("stripWorktree", () => {
  it("strips the worktree prefix when path is inside root", () => {
    expect(stripWorktree("/work/packages/web/src/foo.tsx", "/work")).toBe(
      "packages/web/src/foo.tsx",
    );
  });

  it("returns empty string when path equals root", () => {
    expect(stripWorktree("/work", "/work")).toBe("");
  });

  it("returns the path unchanged when no root is given", () => {
    expect(stripWorktree("/etc/foo.txt")).toBe("/etc/foo.txt");
  });

  it("returns the path unchanged when outside the worktree", () => {
    expect(stripWorktree("/etc/foo.txt", "/work")).toBe("/etc/foo.txt");
  });
});

describe("singleLine", () => {
  it("collapses whitespace and trims", () => {
    expect(singleLine("  echo   hello\n  world\t\there  ")).toBe("echo hello world here");
  });

  it("truncates when longer than max with ellipsis", () => {
    const long = "a".repeat(80);
    const out = singleLine(long, 60);
    expect(out.length).toBe(60);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns input unchanged when under the limit", () => {
    expect(singleLine("hello", 60)).toBe("hello");
  });
});

describe("formatInlineArg — Read/Edit/Write", () => {
  it("strips the worktree path for Read inside the worktree", () => {
    expect(
      formatInlineArg(
        "Read",
        { file_path: "/work/packages/web/src/foo.tsx" },
        { worktreePath: "/work" },
      ),
    ).toBe("packages/web/src/foo.tsx");
  });

  it("returns short outside-worktree paths unchanged", () => {
    expect(
      formatInlineArg(
        "Read",
        { file_path: "/etc/some/short/file.txt" },
        { worktreePath: "/work" },
      ),
    ).toBe("/etc/some/short/file.txt");
  });

  it("compresses very long absolute paths to last three segments", () => {
    const longPath =
      "/very/long/absolute/path/that/clearly/exceeds/the/eighty/character/cap/we/use/here/for/sure/a/b/c.tsx";
    expect(formatInlineArg("Read", { file_path: longPath })).toBe("…/a/b/c.tsx");
  });

  it("falls back to generic preview when file_path is missing", () => {
    expect(formatInlineArg("Read", {})).toBe("");
  });

  it("applies the same rules to Edit and Write", () => {
    expect(
      formatInlineArg(
        "Edit",
        { file_path: "/work/foo.ts" },
        { worktreePath: "/work" },
      ),
    ).toBe("foo.ts");
    expect(
      formatInlineArg(
        "Write",
        { file_path: "/work/bar.ts" },
        { worktreePath: "/work" },
      ),
    ).toBe("bar.ts");
  });
});

describe("formatInlineArg — Glob", () => {
  it("returns the pattern", () => {
    expect(formatInlineArg("Glob", { pattern: "**/*.tsx" })).toBe("**/*.tsx");
  });

  it("truncates very long patterns", () => {
    const pattern = "a".repeat(120);
    const out = formatInlineArg("Glob", { pattern });
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("formatInlineArg — Grep", () => {
  it("renders quoted pattern and stripped path", () => {
    expect(
      formatInlineArg(
        "Grep",
        { pattern: "TODO", path: "/work/src" },
        { worktreePath: "/work" },
      ),
    ).toBe('"TODO" src');
  });

  it("omits the path when not provided", () => {
    expect(formatInlineArg("Grep", { pattern: "TODO" })).toBe('"TODO"');
  });

  it("truncates patterns longer than 40 chars", () => {
    const pattern = "x".repeat(60);
    const out = formatInlineArg("Grep", { pattern });
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    const inner = out.slice(1, -1);
    expect(inner.length).toBe(40);
    expect(inner.endsWith("…")).toBe(true);
  });
});

describe("formatInlineArg — Bash", () => {
  it("collapses whitespace and trims", () => {
    expect(formatInlineArg("Bash", { command: "echo   hello\n  world" })).toBe(
      "echo hello world",
    );
  });

  it("caps Bash commands at 60 characters with ellipsis", () => {
    const command = "echo " + "y".repeat(120);
    const out = formatInlineArg("Bash", { command });
    expect(out.length).toBe(60);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("formatInlineArg — generic / unknown", () => {
  it("returns empty string for unknown tool with empty input", () => {
    expect(formatInlineArg("MysteryTool", {})).toBe("");
  });

  it("walks the priority list for unknown tools", () => {
    expect(formatInlineArg("MysteryTool", { query: "find me" })).toBe("find me");
  });
});

describe("formatResultSummary", () => {
  it("returns pending when result is undefined", () => {
    expect(formatResultSummary("Read", undefined)).toEqual({ text: "", tone: "pending" });
  });

  it("Read ok with non-empty body counts lines", () => {
    expect(
      formatResultSummary("Read", makeResult({ status: "ok", body: "line1\nline2\nline3\n" })),
    ).toEqual({ text: "(3 lines)", tone: "ok" });
  });

  it("Read ok with empty body returns 0 lines", () => {
    expect(formatResultSummary("Read", makeResult({ status: "ok", body: "" }))).toEqual({
      text: "(0 lines)",
      tone: "ok",
    });
  });

  it("Read error with ENOENT body returns file not found", () => {
    expect(
      formatResultSummary(
        "Read",
        makeResult({ status: "error", body: "ENOENT: no such file" }),
      ),
    ).toEqual({ text: "(file not found)", tone: "error" });
  });

  it("Bash error returns exit 1 with error tone", () => {
    expect(formatResultSummary("Bash", makeResult({ status: "error", body: "boom" }))).toEqual({
      text: "(exit 1)",
      tone: "error",
    });
  });

  it("Bash ok counts non-empty lines", () => {
    expect(
      formatResultSummary("Bash", makeResult({ status: "ok", body: "a\nb\nc\n" })),
    ).toEqual({ text: "(exit 0, 3 lines)", tone: "ok" });
  });

  it("Glob ok counts non-empty lines as files", () => {
    expect(
      formatResultSummary(
        "Glob",
        makeResult({ status: "ok", body: "src/a.ts\nsrc/b.ts\n" }),
      ),
    ).toEqual({ text: "(2 files)", tone: "ok" });
  });

  it("Grep ok with grep-style body counts matches and unique files", () => {
    const body = [
      "path/to/file1:42:hit one",
      "path/to/file2:43:hit two",
      "path/to/file3:44:hit three",
      "path/to/file1:99:hit again",
    ].join("\n");
    expect(formatResultSummary("Grep", makeResult({ status: "ok", body }))).toEqual({
      text: "(4 matches in 3 files)",
      tone: "ok",
    });
  });

  it("Grep ok with file-only body counts files", () => {
    const body = ["path/to/file1", "path/to/file2"].join("\n");
    expect(formatResultSummary("Grep", makeResult({ status: "ok", body }))).toEqual({
      text: "(2 files)",
      tone: "ok",
    });
  });

  it("partial result returns truncated with partial tone", () => {
    expect(
      formatResultSummary("Read", makeResult({ status: "partial", body: "partial body" })),
    ).toEqual({ text: "(truncated)", tone: "partial" });
  });

  it("Edit ok returns ok", () => {
    expect(formatResultSummary("Edit", makeResult({ status: "ok", body: "" }))).toEqual({
      text: "(ok)",
      tone: "ok",
    });
  });

  it("Edit error returns failed", () => {
    expect(formatResultSummary("Edit", makeResult({ status: "error", body: "x" }))).toEqual({
      text: "(failed)",
      tone: "error",
    });
  });
});
