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
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });

  it("highlights fenced ts code block with language class and tokens", () => {
    const text = "```ts\nconst x: number = 42;\n```";
    act(() => {
      root.render(createElement(MarkdownView, { text }));
    });
    const code = container.querySelector("pre code");
    expect(code).not.toBeNull();
    expect(code?.className).toContain("hljs");
    expect(code?.className).toContain("language-typescript");
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

  it("forbids phishing and style surfaces in raw html", () => {
    const text = `
<style>body{display:none}</style>
<form><input name="password"><button>submit</button></form>
<dialog open>locked</dialog>
<p style="position:fixed">visible</p>
`;
    act(() => {
      root.render(createElement(MarkdownView, { text }));
    });
    expect(container.querySelector("style")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("dialog")).toBeNull();
    expect(container.querySelector("p")?.getAttribute("style")).toBeNull();
  });

  it("sanitizes fenced language classes before rendering html attributes", () => {
    const text = "```ts\" style=\"position:fixed\nconst x = 1;\n```";
    act(() => {
      root.render(createElement(MarkdownView, { text }));
    });
    const code = container.querySelector("pre code");
    expect(code).not.toBeNull();
    expect(code?.className).toContain("language-plaintext");
    expect(code?.getAttribute("style")).toBeNull();
  });

  it("removes unsafe href schemes", () => {
    const text = "[bad](javascript:alert(1)) [data](data:text/html,hi) [ok](/sessions)";
    act(() => {
      root.render(createElement(MarkdownView, { text }));
    });
    const links = Array.from(container.querySelectorAll("a"));
    expect(links[0]?.hasAttribute("href")).toBe(false);
    expect(links[1]?.hasAttribute("href")).toBe(false);
    expect(links[2]?.getAttribute("href")).toBe("/sessions");
  });
});
