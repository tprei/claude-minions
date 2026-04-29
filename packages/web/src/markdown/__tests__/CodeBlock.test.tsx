import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CodeBlock } from "../CodeBlock.js";

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

describe("CodeBlock", () => {
  it("renders highlighted JSON with hljs token spans", () => {
    const code = '{ "name": "minions", "count": 3 }';
    act(() => {
      root.render(createElement(CodeBlock, { code, language: "json" }));
    });
    const codeEl = container.querySelector("pre code");
    expect(codeEl).not.toBeNull();
    expect(codeEl?.className).toContain("hljs");
    expect(codeEl?.className).toContain("language-json");
    expect(container.querySelectorAll("pre code .hljs-attr").length).toBeGreaterThan(0);
  });

  it("populates clipboard when copy button clicked", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const code = "echo hello";
    act(() => {
      root.render(createElement(CodeBlock, { code, language: "bash" }));
    });
    const btn = container.querySelector("button");
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe("Copy");

    act(() => {
      btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith("echo hello");

    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("button")?.textContent).toBe("Copied");
  });

  it("hides copy button when copy=false", () => {
    act(() => {
      root.render(createElement(CodeBlock, { code: "x = 1", language: "python", copy: false }));
    });
    expect(container.querySelector("button")).toBeNull();
  });
});
