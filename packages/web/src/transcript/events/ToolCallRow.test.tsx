import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolCallEvent, ToolResultEvent } from "@minions/shared";
import { ToolCallRow } from "./ToolCallRow.js";
import { WorktreePathContext } from "./toolFormat.js";

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

function makeCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    kind: "tool_call",
    id: "evt_1",
    sessionSlug: "s",
    seq: 1,
    turn: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    toolCallId: "tc_1",
    toolName: "Read",
    toolKind: "read",
    summary: "",
    input: { file_path: "/work/packages/web/src/foo.tsx" },
    ...overrides,
  };
}

function makeResult(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return {
    kind: "tool_result",
    id: "evt_2",
    sessionSlug: "s",
    seq: 2,
    turn: 1,
    timestamp: "2026-01-01T00:00:01.000Z",
    toolCallId: "tc_1",
    status: "ok",
    format: "text",
    body: "line1\nline2\nline3\n",
    ...overrides,
  };
}

describe("ToolCallRow", () => {
  it("renders verb and inline arg from the formatter", () => {
    act(() => {
      root.render(createElement(ToolCallRow, { call: makeCall() }));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Read file");
    expect(text).toContain("/work/packages/web/src/foo.tsx");
  });

  it("strips the worktree prefix when wrapped in WorktreePathContext", () => {
    act(() => {
      root.render(
        createElement(
          WorktreePathContext.Provider,
          { value: "/work" },
          createElement(ToolCallRow, { call: makeCall() }),
        ),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("packages/web/src/foo.tsx");
    expect(text).not.toContain("/work/packages/web/src/foo.tsx");
  });

  it("shows result summary text in the collapsed header when result is present", () => {
    act(() => {
      root.render(
        createElement(ToolCallRow, { call: makeCall(), result: makeResult() }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("(3 lines)");
    expect(text).toContain("OK");
  });

  it("shows the pending pill when no result is provided", () => {
    act(() => {
      root.render(createElement(ToolCallRow, { call: makeCall() }));
    });
    const pills = Array.from(container.querySelectorAll(".pill"));
    expect(pills.some((p) => p.textContent === "…")).toBe(true);
  });

  it("toggles the expanded JSON view on click", () => {
    act(() => {
      root.render(createElement(ToolCallRow, { call: makeCall() }));
    });
    expect(container.querySelector("pre")).toBeNull();

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("file_path");

    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("pre")).toBeNull();
  });
});
