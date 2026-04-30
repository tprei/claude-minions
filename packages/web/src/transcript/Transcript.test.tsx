import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  AssistantTextEvent,
  ToolCallEvent,
  ToolKind,
  ToolResultEvent,
} from "@minions/shared";
import { Transcript } from "./Transcript.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
});

const TS = "2026-01-01T00:00:00.000Z";

function toolKindFor(toolName: string): ToolKind {
  switch (toolName) {
    case "Read":
      return "read";
    case "Write":
      return "write";
    case "Edit":
      return "edit";
    case "Bash":
      return "shell";
    case "Grep":
      return "search";
    case "Glob":
      return "glob";
    default:
      return "other";
  }
}

function toolCall(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  turn = 1,
  seq = 0,
): ToolCallEvent {
  return {
    kind: "tool_call",
    id: `evt-call-${id}-${seq}`,
    sessionSlug: "test",
    seq,
    turn,
    timestamp: TS,
    toolCallId: id,
    toolName,
    toolKind: toolKindFor(toolName),
    summary: "",
    input,
  };
}

function toolResult(
  toolCallId: string,
  body: string,
  status: "ok" | "error" = "ok",
  turn = 1,
  seq = 0,
): ToolResultEvent {
  return {
    kind: "tool_result",
    id: `evt-result-${toolCallId}-${seq}`,
    sessionSlug: "test",
    seq,
    turn,
    timestamp: TS,
    toolCallId,
    status,
    format: "text",
    body,
  };
}

function assistantText(text: string, turn = 1, seq = 0): AssistantTextEvent {
  return {
    kind: "assistant_text",
    id: `evt-text-${seq}`,
    sessionSlug: "test",
    seq,
    turn,
    timestamp: TS,
    text,
  };
}

describe("Transcript wrap prop", () => {
  it("default mount renders inner-only (no panel wrapper, no collapse button)", () => {
    act(() => {
      root.render(createElement(Transcript, { events: [] }));
    });
    expect(container.querySelector('[data-panel="transcript"]')).toBeNull();
    expect(container.querySelector('[data-testid="transcript-collapse"]')).toBeNull();
    expect(container.querySelector('[role="tablist"][aria-label="Transcript view"]')).not.toBeNull();
  });

  it("wrap=true mount renders standalone wrapper with collapse button", () => {
    act(() => {
      root.render(createElement(Transcript, { events: [], wrap: true }));
    });
    expect(container.querySelector('[data-panel="transcript"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="transcript-collapse"]')).not.toBeNull();
  });
});

describe("Transcript tool-call clustering", () => {
  it("five consecutive Reads in the same turn render as one collapsed cluster", () => {
    const reads = Array.from({ length: 5 }, (_, i) =>
      toolCall(`tc${i + 1}`, "Read", { file_path: `/work/file${i + 1}.tsx` }, 1, i + 1),
    );
    const results = Array.from({ length: 5 }, (_, i) =>
      toolResult(`tc${i + 1}`, `body ${i + 1}\n`, "ok", 1, i + 6),
    );
    act(() => {
      root.render(createElement(Transcript, { events: [...reads, ...results] }));
    });

    const text = container.textContent ?? "";
    const headerMatches = text.match(/5 Reads/g) ?? [];
    expect(headerMatches).toHaveLength(1);

    for (const r of reads) {
      const filePath = (r.input as { file_path: string }).file_path;
      expect(text).not.toContain(filePath);
    }
  });

  it("two consecutive Reads render as a default-open cluster (items < 3)", () => {
    const events = [
      toolCall("tc1", "Read", { file_path: "/work/a.tsx" }, 1, 1),
      toolCall("tc2", "Read", { file_path: "/work/b.tsx" }, 1, 2),
    ];
    act(() => {
      root.render(createElement(Transcript, { events }));
    });

    const text = container.textContent ?? "";
    expect(text).toMatch(/2 Reads/);
    expect(text).toContain("/work/a.tsx");
    expect(text).toContain("/work/b.tsx");
  });

  it("Read, Grep, Read renders three single rows with no cluster header", () => {
    const events = [
      toolCall("tc1", "Read", { file_path: "/work/a.tsx" }, 1, 1),
      toolCall("tc2", "Grep", { pattern: "needle" }, 1, 2),
      toolCall("tc3", "Read", { file_path: "/work/b.tsx" }, 1, 3),
    ];
    act(() => {
      root.render(createElement(Transcript, { events }));
    });

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\d+ Reads/);
    expect(text).not.toMatch(/\d+ tool calls?/);
    expect(text).toContain("/work/a.tsx");
    expect(text).toContain("/work/b.tsx");
  });

  it("an assistant_text event between tool_calls breaks the cluster into two", () => {
    const events = [
      toolCall("tc1", "Read", { file_path: "/work/a.tsx" }, 1, 1),
      toolCall("tc2", "Read", { file_path: "/work/b.tsx" }, 1, 2),
      assistantText("midpoint reply", 1, 3),
      toolCall("tc3", "Read", { file_path: "/work/c.tsx" }, 1, 4),
      toolCall("tc4", "Read", { file_path: "/work/d.tsx" }, 1, 5),
    ];
    act(() => {
      root.render(createElement(Transcript, { events }));
    });

    const text = container.textContent ?? "";
    const headerMatches = text.match(/2 Reads/g) ?? [];
    expect(headerMatches).toHaveLength(2);
    expect(text).toContain("midpoint reply");
  });

  it("clustered tool_results render inline in rows, not as standalone ml-6 ToolResults", () => {
    const sentinel = "SENTINEL_BODY_XYZ_42";
    const events = [
      toolCall("tc1", "Read", { file_path: "/work/a.tsx" }, 1, 1),
      toolCall("tc2", "Read", { file_path: "/work/b.tsx" }, 1, 2),
      toolCall("tc3", "Read", { file_path: "/work/c.tsx" }, 1, 3),
      toolResult("tc1", `${sentinel} first\nlineB\n`, "ok", 1, 4),
      toolResult("tc2", `${sentinel} second\nlineB\n`, "ok", 1, 5),
      toolResult("tc3", `${sentinel} third\nlineB\n`, "ok", 1, 6),
    ];
    act(() => {
      root.render(createElement(Transcript, { events }));
    });

    const clusterButton = Array.from(container.querySelectorAll("button")).find((b) =>
      /3 Reads/.test(b.textContent ?? ""),
    );
    expect(clusterButton).toBeDefined();
    act(() => {
      clusterButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const rowButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
      (b.textContent ?? "").includes("Read file"),
    );
    expect(rowButtons).toHaveLength(3);
    for (const rb of rowButtons) {
      act(() => {
        rb.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }

    expect(container.textContent ?? "").toContain(sentinel);
    expect(container.querySelector('[class*="ml-6"]')).toBeNull();
  });

  it("a tool_result with no matching tool_call renders as an orphan with the amber border", () => {
    const events = [toolResult("missing-tc", "ORPHAN_BODY_PREVIEW", "ok", 1, 1)];
    act(() => {
      root.render(createElement(Transcript, { events }));
    });

    expect(container.textContent ?? "").toContain("orphaned tool result");
    expect(container.querySelector('[class*="border-amber"]')).not.toBeNull();
  });

  it("worktreePath is stripped from the inline preview of a single tool_call", () => {
    const events = [
      toolCall("tc1", "Read", { file_path: "/work/packages/web/src/foo.tsx" }, 1, 1),
    ];
    act(() => {
      root.render(createElement(Transcript, { events, worktreePath: "/work" }));
    });

    const text = container.textContent ?? "";
    expect(text).toContain("packages/web/src/foo.tsx");
    expect(text).not.toContain("/work/packages/web/src/foo.tsx");
  });

  it("a turn boundary breaks a tool_call cluster", () => {
    const events = [
      toolCall("tc1", "Read", { file_path: "/work/a.tsx" }, 1, 1),
      toolCall("tc2", "Read", { file_path: "/work/b.tsx" }, 2, 2),
    ];
    act(() => {
      root.render(createElement(Transcript, { events }));
    });

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/2 Reads/);
    expect(text).toContain("/work/a.tsx");
    expect(text).toContain("/work/b.tsx");
  });
});
