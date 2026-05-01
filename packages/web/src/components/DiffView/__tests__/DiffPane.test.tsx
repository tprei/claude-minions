import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiffPane } from "../DiffPane.js";
import { parsePatch } from "../parsePatch.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

const TWO_HUNK_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 const greeting = "hello";
-export function foo(): number { return 1; }
+export function foo(): number { return 2; }
@@ -10,2 +10,3 @@
 const bar = 1;
+const baz = 2;
 const qux = 3;
`;

const BINARY_DIFF = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

describe("DiffPane", () => {
  it("renders one block per hunk with data-hunk-index", () => {
    const file = parsePatch(TWO_HUNK_DIFF)[0]!;
    act(() => {
      root.render(
        createElement(DiffPane, {
          file,
          viewMode: "unified",
          hunkIndex: 0,
          onPrevHunk: () => {},
          onNextHunk: () => {},
        }),
      );
    });
    const blocks = container.querySelectorAll("[data-hunk-index]");
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.getAttribute("data-hunk-index")).toBe("0");
    expect(blocks[1]!.getAttribute("data-hunk-index")).toBe("1");
    expect(
      container.querySelector("[data-active-hunk]")?.getAttribute("data-active-hunk"),
    ).toBe("0");
  });

  it("colors add/del lines and leaves context plain", () => {
    const file = parsePatch(TWO_HUNK_DIFF)[0]!;
    act(() => {
      root.render(
        createElement(DiffPane, {
          file,
          viewMode: "unified",
          hunkIndex: 0,
          onPrevHunk: () => {},
          onNextHunk: () => {},
        }),
      );
    });
    const rows = Array.from(container.querySelectorAll("[data-hunk-index] > div"));
    const hasAdd = rows.some((r) => r.className.includes("bg-green-950"));
    const hasDel = rows.some((r) => r.className.includes("bg-red-950"));
    expect(hasAdd).toBe(true);
    expect(hasDel).toBe(true);
    const contextRows = rows.filter(
      (r) =>
        !r.className.includes("bg-green-950") &&
        !r.className.includes("bg-red-950") &&
        !r.textContent?.startsWith("@@"),
    );
    expect(contextRows.length).toBeGreaterThan(0);
  });

  it("invokes prev/next callbacks and disables at edges", () => {
    const file = parsePatch(TWO_HUNK_DIFF)[0]!;
    const onPrevHunk = vi.fn();
    const onNextHunk = vi.fn();
    act(() => {
      root.render(
        createElement(DiffPane, {
          file,
          viewMode: "unified",
          hunkIndex: 0,
          onPrevHunk,
          onNextHunk,
        }),
      );
    });
    const buttons = Array.from(
      container.querySelectorAll("button"),
    ) as HTMLButtonElement[];
    const prev = buttons.find((b) => b.textContent === "Prev")!;
    const next = buttons.find((b) => b.textContent === "Next")!;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    act(() => {
      next.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onNextHunk).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        createElement(DiffPane, {
          file,
          viewMode: "unified",
          hunkIndex: 1,
          onPrevHunk,
          onNextHunk,
        }),
      );
    });
    const buttons2 = Array.from(
      container.querySelectorAll("button"),
    ) as HTMLButtonElement[];
    const prev2 = buttons2.find((b) => b.textContent === "Prev")!;
    const next2 = buttons2.find((b) => b.textContent === "Next")!;
    expect(prev2.disabled).toBe(false);
    expect(next2.disabled).toBe(true);
    act(() => {
      prev2.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onPrevHunk).toHaveBeenCalledTimes(1);
  });

  it("renders binary placeholder for binary files", () => {
    const file = parsePatch(BINARY_DIFF)[0]!;
    act(() => {
      root.render(
        createElement(DiffPane, {
          file,
          viewMode: "unified",
          hunkIndex: 0,
          onPrevHunk: () => {},
          onNextHunk: () => {},
        }),
      );
    });
    expect(container.textContent).toContain("Binary file");
    expect(container.querySelectorAll("[data-hunk-index]").length).toBe(0);
  });

  it("renders highlighted code with hljs class", () => {
    const file = parsePatch(TWO_HUNK_DIFF)[0]!;
    act(() => {
      root.render(
        createElement(DiffPane, {
          file,
          viewMode: "unified",
          hunkIndex: 0,
          onPrevHunk: () => {},
          onNextHunk: () => {},
        }),
      );
    });
    const codes = container.querySelectorAll("code.hljs");
    expect(codes.length).toBeGreaterThan(0);
  });

  it("renders toggleSlot in the header", () => {
    const file = parsePatch(TWO_HUNK_DIFF)[0]!;
    act(() => {
      root.render(
        createElement(DiffPane, {
          file,
          viewMode: "unified",
          hunkIndex: 0,
          onPrevHunk: () => {},
          onNextHunk: () => {},
          toggleSlot: createElement(
            "button",
            { "data-testid": "toggle" },
            "Toggle",
          ),
        }),
      );
    });
    expect(container.querySelector("[data-testid=toggle]")).not.toBeNull();
  });
});
