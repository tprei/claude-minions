import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement, useRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDragToDismiss, usePullToRefresh, useSwipeToDismiss } from "../gestures.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FrameJob {
  id: number;
  cb: FrameRequestCallback;
  cancelled: boolean;
}

let rafQueue: FrameJob[] = [];
let rafCounter = 0;
let mockNow = 0;
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCaf: typeof globalThis.cancelAnimationFrame;
let originalNowDescriptor: PropertyDescriptor | undefined;
let originalMatchMedia: typeof window.matchMedia;
let reducedMotion = false;
let vibrateMock: ReturnType<typeof vi.fn>;

function flushFrames(advanceMs = 250): void {
  let safety = 200;
  while (rafQueue.length > 0 && safety-- > 0) {
    const items = rafQueue;
    rafQueue = [];
    mockNow += advanceMs;
    for (const item of items) {
      if (!item.cancelled) item.cb(mockNow);
    }
  }
}

function makePointerEvent(
  type: string,
  init: { pointerId?: number; clientX: number; clientY: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1, configurable: true });
  Object.defineProperty(event, "clientX", { value: init.clientX, configurable: true });
  Object.defineProperty(event, "clientY", { value: init.clientY, configurable: true });
  return event;
}

type DragState = ReturnType<typeof useDragToDismiss>;
type PullState = ReturnType<typeof usePullToRefresh>;

let lastDragState: DragState | null = null;
let lastPullState: PullState | null = null;

function DragHarness(props: {
  onDismiss: () => void;
  opts: Parameters<typeof useDragToDismiss>[2];
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const state = useDragToDismiss(ref, props.onDismiss, props.opts);
  lastDragState = state;
  return createElement("div", {
    ref,
    "data-testid": "drag-target",
    style: { width: 200, height: 200 },
  });
}

function SwipeHarness(props: { onDismiss: () => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useSwipeToDismiss(ref, props.onDismiss);
  return createElement("div", { ref, "data-testid": "swipe-target" });
}

function PullHarness(props: { onRefresh: () => void | Promise<void> }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const state = usePullToRefresh(ref, props.onRefresh);
  lastPullState = state;
  return createElement("div", { ref, "data-testid": "pull-target" });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  rafQueue = [];
  rafCounter = 0;
  mockNow = 0;
  reducedMotion = false;
  lastDragState = null;
  lastPullState = null;

  originalRaf = globalThis.requestAnimationFrame;
  originalCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    rafCounter += 1;
    const id = rafCounter;
    rafQueue.push({ id, cb, cancelled: false });
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number): void => {
    const job = rafQueue.find((j) => j.id === id);
    if (job) job.cancelled = true;
  }) as typeof globalThis.cancelAnimationFrame;

  originalNowDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
  Object.defineProperty(performance, "now", {
    value: () => mockNow,
    configurable: true,
    writable: true,
  });

  vibrateMock = vi.fn();
  Object.defineProperty(navigator, "vibrate", {
    value: vibrateMock,
    configurable: true,
    writable: true,
  });

  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce") ? reducedMotion : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);

  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
  if (originalNowDescriptor) {
    Object.defineProperty(performance, "now", originalNowDescriptor);
  }
  window.matchMedia = originalMatchMedia;
});

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function getDragTarget(): HTMLElement {
  const el = container.querySelector('[data-testid="drag-target"]') as HTMLElement | null;
  if (!el) throw new Error("drag target not rendered");
  return el;
}

function getPullTarget(): HTMLElement {
  const el = container.querySelector('[data-testid="pull-target"]') as HTMLElement | null;
  if (!el) throw new Error("pull target not rendered");
  return el;
}

function getSwipeTarget(): HTMLElement {
  const el = container.querySelector('[data-testid="swipe-target"]') as HTMLElement | null;
  if (!el) throw new Error("swipe target not rendered");
  return el;
}

describe("useDragToDismiss", () => {
  it("does not engage when horizontal motion dominates a 'down' direction drag", async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(createElement(DragHarness, { onDismiss, opts: { direction: "down" } }));
    });
    await flushMicrotasks();

    const el = getDragTarget();

    await act(async () => {
      el.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 50, clientY: 10 }));
    });
    await act(async () => {
      flushFrames();
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointerup", { clientX: 50, clientY: 10 }));
    });
    await flushMicrotasks();

    expect(onDismiss).not.toHaveBeenCalled();
    expect(lastDragState?.dragging).toBe(false);
  });

  it("engages once dy crosses the 8px deadzone and updates offset on subsequent moves", async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(createElement(DragHarness, { onDismiss, opts: { direction: "down" } }));
    });
    await flushMicrotasks();

    const el = getDragTarget();

    await act(async () => {
      el.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 0, clientY: 20 }));
    });
    await act(async () => {
      flushFrames();
    });

    expect(lastDragState?.dragging).toBe(true);
    expect(lastDragState?.offset).toBe(20);

    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 0, clientY: 40 }));
    });
    await act(async () => {
      flushFrames();
    });

    expect(lastDragState?.dragging).toBe(true);
    expect(lastDragState?.offset).toBe(40);
  });

  it("fires haptic vibrate exactly once when progress crosses 1.0 during a drag", async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(
        createElement(DragHarness, { onDismiss, opts: { direction: "down", threshold: 80 } }),
      );
    });
    await flushMicrotasks();

    const el = getDragTarget();

    await act(async () => {
      el.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 0, clientY: 100 }));
    });
    await act(async () => {
      flushFrames();
    });

    expect(vibrateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 0, clientY: 120 }));
    });
    await act(async () => {
      flushFrames();
    });

    expect(vibrateMock).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss when released past threshold", async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(
        createElement(DragHarness, { onDismiss, opts: { direction: "down", threshold: 80 } }),
      );
    });
    await flushMicrotasks();

    const el = getDragTarget();

    await act(async () => {
      el.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 0, clientY: 100 }));
    });
    await act(async () => {
      flushFrames();
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointerup", { clientX: 0, clientY: 100 }));
    });
    await flushMicrotasks();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss below threshold and snaps offset back to 0", async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(
        createElement(DragHarness, { onDismiss, opts: { direction: "down", threshold: 80 } }),
      );
    });
    await flushMicrotasks();

    const el = getDragTarget();

    await act(async () => {
      el.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 0, clientY: 50 }));
    });
    await act(async () => {
      flushFrames();
    });

    expect(lastDragState?.offset).toBe(50);

    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointerup", { clientX: 0, clientY: 50 }));
    });
    await act(async () => {
      flushFrames();
    });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(lastDragState?.dragging).toBe(false);
    expect(lastDragState?.offset).toBe(0);
  });

  it("skips the gesture when enabled() returns false", async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(
        createElement(DragHarness, {
          onDismiss,
          opts: { direction: "down", threshold: 80, enabled: () => false },
        }),
      );
    });
    await flushMicrotasks();

    const el = getDragTarget();

    await act(async () => {
      el.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 0, clientY: 200 }));
    });
    await act(async () => {
      flushFrames();
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointerup", { clientX: 0, clientY: 200 }));
    });
    await flushMicrotasks();

    expect(onDismiss).not.toHaveBeenCalled();
    expect(lastDragState?.dragging).toBe(false);
  });

  it("stays inert under reduced motion even when pointermove crosses threshold", async () => {
    reducedMotion = true;
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(
        createElement(DragHarness, { onDismiss, opts: { direction: "down", threshold: 80 } }),
      );
    });
    await flushMicrotasks();

    const el = getDragTarget();

    await act(async () => {
      el.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 0, clientY: 200 }));
    });
    await act(async () => {
      flushFrames();
    });

    expect(lastDragState?.dragging).toBe(false);
  });
});

describe("useSwipeToDismiss", () => {
  it("dismisses on pointerup past threshold even with no intermediate pointermove", async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(createElement(SwipeHarness, { onDismiss }));
    });
    await flushMicrotasks();

    const el = getSwipeTarget();

    await act(async () => {
      el.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointerup", { clientX: 0, clientY: 70 }));
    });
    await flushMicrotasks();

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("usePullToRefresh", () => {
  it("flips refreshing to true while onRefresh is pending and back to false after it resolves", async () => {
    let resolveRefresh: (() => void) | undefined;
    const refreshPromise = new Promise<void>((res) => {
      resolveRefresh = res;
    });
    const onRefresh = vi.fn(() => refreshPromise);

    await act(async () => {
      root.render(createElement(PullHarness, { onRefresh }));
    });
    await flushMicrotasks();

    const el = getPullTarget();

    await act(async () => {
      el.dispatchEvent(makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointermove", { clientX: 0, clientY: 80 }));
    });
    await act(async () => {
      flushFrames();
    });
    await act(async () => {
      window.dispatchEvent(makePointerEvent("pointerup", { clientX: 0, clientY: 80 }));
    });
    await act(async () => {
      flushFrames();
    });
    await flushMicrotasks();

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(lastPullState?.refreshing).toBe(true);

    await act(async () => {
      resolveRefresh?.();
      await refreshPromise;
    });
    await flushMicrotasks();
    await act(async () => {
      flushFrames();
    });
    await flushMicrotasks();

    expect(lastPullState?.refreshing).toBe(false);
  });
});
