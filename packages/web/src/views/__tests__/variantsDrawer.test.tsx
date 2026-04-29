import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VariantsDrawer } from "../variantsDrawer.js";

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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setReactValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) throw new Error("no value setter");
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("VariantsDrawer", () => {
  it("renders the create form when no result is set", () => {
    const api = { post: vi.fn() };
    act(() => {
      root.render(createElement(VariantsDrawer, { api, onClose: () => {} }));
    });
    expect(container.querySelector('[data-testid="variants-drawer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="variants-submit"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="variants-result"]')).toBeNull();
  });

  it("posts to /api/sessions/variants and shows spawned slugs on success", async () => {
    const post = vi.fn().mockResolvedValue({
      parentSlug: "parent-slug",
      childSlugs: ["child-a", "child-b"],
    });

    act(() => {
      root.render(createElement(VariantsDrawer, { api: { post }, onClose: () => {} }));
    });

    const promptEl = container.querySelector("textarea") as HTMLTextAreaElement;
    const countEl = container.querySelector('input[type="number"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    act(() => {
      setReactValue(promptEl, "fan out the task");
      setReactValue(countEl, "3");
    });

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toBe("/api/sessions/variants");
    expect(post.mock.calls[0]![1]).toEqual({ prompt: "fan out the task", count: 3 });

    const result = container.querySelector('[data-testid="variants-result"]');
    expect(result).not.toBeNull();
    expect(result!.textContent).toContain("parent-slug");
    expect(result!.textContent).toContain("child-a");
    expect(result!.textContent).toContain("child-b");
  });

  it("blocks submission when count is out of range", async () => {
    const post = vi.fn();
    act(() => {
      root.render(createElement(VariantsDrawer, { api: { post }, onClose: () => {} }));
    });

    const promptEl = container.querySelector("textarea") as HTMLTextAreaElement;
    const countEl = container.querySelector('input[type="number"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    act(() => {
      setReactValue(promptEl, "ok");
      setReactValue(countEl, "11");
    });

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(post).not.toHaveBeenCalled();
    expect(container.textContent).toContain("between 1 and 10");
  });
});
