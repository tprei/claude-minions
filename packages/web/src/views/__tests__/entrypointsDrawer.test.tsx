import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Entrypoint } from "@minions/shared";
import { EntrypointsDrawer } from "../entrypointsDrawer.js";

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

function makeEntrypoint(overrides: Partial<Entrypoint> = {}): Entrypoint {
  return {
    id: "ep-1",
    kind: "github-webhook",
    label: "demo hook",
    enabled: true,
    config: {},
    createdAt: "2026-04-29T00:00:00Z",
    updatedAt: "2026-04-29T00:00:00Z",
    ...overrides,
  };
}

describe("EntrypointsDrawer", () => {
  it("loads and lists existing entrypoints from GET /api/entrypoints", async () => {
    const get = vi.fn().mockResolvedValue({ items: [makeEntrypoint(), makeEntrypoint({ id: "ep-2", label: "second", kind: "custom" })] });
    const post = vi.fn();

    act(() => {
      root.render(createElement(EntrypointsDrawer, { api: { get, post }, onClose: () => {} }));
    });
    await flush();

    expect(get).toHaveBeenCalledWith("/api/entrypoints");
    const list = container.querySelector('[data-testid="entrypoints-list"]');
    expect(list).not.toBeNull();
    expect(list!.textContent).toContain("demo hook");
    expect(list!.textContent).toContain("second");
  });

  it("registers a new entrypoint and reloads the list", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [makeEntrypoint({ label: "fresh" })] });
    const post = vi.fn().mockResolvedValue(makeEntrypoint({ label: "fresh" }));

    act(() => {
      root.render(createElement(EntrypointsDrawer, { api: { get, post }, onClose: () => {} }));
    });
    await flush();

    const newBtn = container.querySelector('[data-testid="entrypoints-new"]') as HTMLButtonElement;
    act(() => { newBtn.click(); });

    const labelInput = container.querySelector('input.input') as HTMLInputElement;
    act(() => {
      setReactValue(labelInput, "fresh");
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toBe("/api/entrypoints");
    expect(post.mock.calls[0]![1]).toEqual({ kind: "custom", label: "fresh" });
    expect(get).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("fresh");
  });

  it("rejects invalid JSON config without calling post", async () => {
    const get = vi.fn().mockResolvedValue({ items: [] });
    const post = vi.fn();

    act(() => {
      root.render(createElement(EntrypointsDrawer, { api: { get, post }, onClose: () => {} }));
    });
    await flush();

    act(() => {
      (container.querySelector('[data-testid="entrypoints-new"]') as HTMLButtonElement).click();
    });

    const labelInput = container.querySelector('input.input') as HTMLInputElement;
    const configEl = container.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      setReactValue(labelInput, "bad cfg");
      setReactValue(configEl, "not-json");
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(post).not.toHaveBeenCalled();
    expect(container.textContent).toContain("valid JSON");
  });
});
