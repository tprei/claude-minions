import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LoopDefinition } from "@minions/shared";
import { LoopsView } from "../loops.js";

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

function makeLoop(overrides: Partial<LoopDefinition> = {}): LoopDefinition {
  return {
    id: "loop-a",
    label: "Nightly checks",
    prompt: "run the watchdog",
    intervalSec: 600,
    enabled: true,
    consecutiveFailures: 0,
    lastRunAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    createdAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

function makeApi(items: LoopDefinition[]) {
  const get = vi.fn(async (path: string) => {
    if (path === "/api/loops") return { items };
    throw new Error(`unexpected GET ${path}`);
  });
  const patch = vi.fn(async () => ({ ok: true }));
  return {
    get,
    post: vi.fn(),
    patch,
    del: vi.fn(),
  };
}

describe("LoopsView", () => {
  it("renders a row per loop returned by the REST client", async () => {
    const api = makeApi([
      makeLoop({ id: "loop-a", label: "Nightly checks" }),
      makeLoop({ id: "loop-b", label: "PR sweeper", enabled: false }),
      makeLoop({ id: "loop-c", label: "Failing loop", consecutiveFailures: 3 }),
    ]);

    act(() => {
      root.render(createElement(LoopsView, { api }));
    });
    await flush();

    expect(api.get).toHaveBeenCalledWith("/api/loops");
    const table = container.querySelector('[data-testid="loops-table"]');
    expect(table).not.toBeNull();
    expect(container.querySelector('[data-testid="loop-row-loop-a"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="loop-row-loop-b"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="loop-row-loop-c"]')).not.toBeNull();
    expect(container.textContent).toContain("Nightly checks");
    expect(container.textContent).toContain("PR sweeper");
    expect(container.textContent).toContain("Failing loop");
    expect(container.textContent).toContain("disabled");
    expect(container.textContent).toContain("failing");
  });

  it("retry calls PATCH /enabled with true for a disabled loop", async () => {
    const api = makeApi([makeLoop({ id: "loop-x", enabled: false, label: "Idle" })]);

    act(() => {
      root.render(createElement(LoopsView, { api }));
    });
    await flush();

    const retryBtn = container.querySelector('[data-testid="loop-retry-loop-x"]') as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn?.disabled).toBe(false);

    await act(async () => {
      retryBtn?.click();
    });
    await flush();

    expect(api.patch).toHaveBeenCalledWith("/api/loops/loop-x/enabled", { enabled: true });
  });

  it("cancel calls PATCH /enabled with false for an enabled loop", async () => {
    const api = makeApi([makeLoop({ id: "loop-y", enabled: true, label: "Live" })]);

    act(() => {
      root.render(createElement(LoopsView, { api }));
    });
    await flush();

    const cancelBtn = container.querySelector('[data-testid="loop-cancel-loop-y"]') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    expect(cancelBtn?.disabled).toBe(false);

    await act(async () => {
      cancelBtn?.click();
    });
    await flush();

    expect(api.patch).toHaveBeenCalledWith("/api/loops/loop-y/enabled", { enabled: false });
  });

  it("renders an empty state when no loops exist", async () => {
    const api = makeApi([]);

    act(() => {
      root.render(createElement(LoopsView, { api }));
    });
    await flush();

    expect(container.querySelector('[data-testid="loops-table"]')).toBeNull();
    expect(container.textContent).toContain("No loops registered");
  });
});
