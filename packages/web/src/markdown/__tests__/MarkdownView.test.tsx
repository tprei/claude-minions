import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownView } from "../MarkdownView.js";

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

describe("MarkdownView", () => {
  it("renders headings, list items, and links", () => {
    const text = "# Title\n\n- item one\n- item two\n\n[home](https://example.com)";
    act(() => {
      root.render(createElement(MarkdownView, { text }));
    });
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelectorAll("li").length).toBe(2);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com");
  });

  it("highlights fenced ts code block with language class and tokens", () => {
    const text = "```ts\nconst x: number = 42;\n```";
    act(() => {
      root.render(createElement(MarkdownView, { text }));
    });
    const code = container.querySelector("pre code");
    expect(code).not.toBeNull();
    expect(code?.className).toContain("hljs");
    expect(code?.className).toContain("language-ts");
    expect(container.querySelectorAll("pre code .hljs-keyword").length).toBeGreaterThan(0);
  });

  it("does not throw and produces highlighted output for unknown language", () => {
    const text = "```fakelang\nfoo bar baz\n```";
    expect(() => {
      act(() => {
        root.render(createElement(MarkdownView, { text }));
      });
    }).not.toThrow();
    const code = container.querySelector("pre code");
    expect(code).not.toBeNull();
    expect(code?.className).toContain("hljs");
  });

  it("renders inline backtick code as <code> outside .hljs block", () => {
    const text = "use the `foo()` helper";
    act(() => {
      root.render(createElement(MarkdownView, { text }));
    });
    const inline = container.querySelector("p > code");
    expect(inline).not.toBeNull();
    expect(inline?.classList.contains("hljs")).toBe(false);
    expect(inline?.textContent).toBe("foo()");
  });

  it("strips <script> tags via DOMPurify", () => {
    const text = "hello <script>alert('xss')</script> world";
    act(() => {
      root.render(createElement(MarkdownView, { text }));
    });
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("alert(");
  });
});
