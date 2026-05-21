import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Diff } from "../Diff.js";

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

const TS_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 0000001..0000002 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 const greeting = "hello";
-export function foo(): number { return 1; }
+export function foo(): number { return 2; }
`;

const PY_DIFF = `diff --git a/script.py b/script.py
--- a/script.py
+++ b/script.py
@@ -1,2 +1,2 @@
-def hello(): return "old"
+def hello(): return "new"
`;

const PLAIN_TEXT = "no diff markers here\njust some output\n";

describe("Diff", () => {
  it("renders hunk header and +/- prefixes", () => {
    act(() => {
      root.render(createElement(Diff, { text: TS_DIFF }));
    });
    expect(container.textContent).toContain("@@ -1,3 +1,3 @@");
    expect(container.textContent).toContain("+");
    expect(container.textContent).toContain("-");
    expect(container.textContent).toContain("export function foo");
  });

  it("applies hljs token spans to .ts diff content", () => {
    act(() => {
      root.render(createElement(Diff, { text: TS_DIFF }));
    });
    const codes = container.querySelectorAll("code.hljs");
    expect(codes.length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".hljs-keyword").length).toBeGreaterThan(0);
  });

  it("detects language for .py file extension", () => {
    act(() => {
      root.render(createElement(Diff, { text: PY_DIFF }));
    });
    expect(container.querySelectorAll(".hljs-keyword").length).toBeGreaterThan(0);
  });

  it("falls back to plain <pre> when input contains no hunks", () => {
    act(() => {
      root.render(createElement(Diff, { text: PLAIN_TEXT }));
    });
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe(PLAIN_TEXT);
  });

  it("renders zero-hunk binary and rename diffs", () => {
    const diff = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`;
    act(() => {
      root.render(createElement(Diff, { text: diff }));
    });
    expect(container.textContent).toContain("img.png");
    expect(container.textContent).toContain("Binary file");
    expect(container.textContent).toContain("old.ts → new.ts");
    expect(container.textContent).toContain("Renamed file");
  });

  it("highlights Go diffs with the same language map as DiffPane", () => {
    const diff = `diff --git a/main.go b/main.go
--- a/main.go
+++ b/main.go
@@ -1,1 +1,1 @@
-func old() {}
+func next() {}
`;
    act(() => {
      root.render(createElement(Diff, { text: diff }));
    });
    expect(container.querySelectorAll(".hljs-keyword").length).toBeGreaterThan(0);
  });

  it("preserves line backgrounds (add/remove kind classes)", () => {
    act(() => {
      root.render(createElement(Diff, { text: TS_DIFF }));
    });
    const lines = container.querySelectorAll(".diff-line");
    expect(lines.length).toBeGreaterThan(0);
    const hasAdd = Array.from(lines).some((l) =>
      l.className.includes("bg-green-950"),
    );
    const hasRemove = Array.from(lines).some((l) =>
      l.className.includes("bg-red-950"),
    );
    expect(hasAdd).toBe(true);
    expect(hasRemove).toBe(true);
  });
});
