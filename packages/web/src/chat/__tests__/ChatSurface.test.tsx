import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BudgetMeterPill } from "../ChatSurface.js";

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

describe("BudgetMeterPill", () => {
  it("renders cost/cap text and a bar capped at the ratio", () => {
    act(() => {
      root.render(createElement(BudgetMeterPill, { costUsd: 1.5, cap: 5 }));
    });
    const pill = container.querySelector('[data-testid="budget-meter"]') as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent?.replace(/\s+/g, " ").trim()).toBe("$1.50 / $5.00");
    const bar = pill.querySelector("span[aria-hidden]") as HTMLElement;
    expect(bar.style.width).toBe("30%");
  });

  it("uses warn tone at >= 80% of cap", () => {
    act(() => {
      root.render(createElement(BudgetMeterPill, { costUsd: 4.5, cap: 5 }));
    });
    const bar = container.querySelector('[data-testid="budget-meter"] span[aria-hidden]') as HTMLElement;
    expect(bar.className).toContain("bg-warn");
    expect(bar.style.width).toBe("90%");
  });

  it("uses danger tone and clamps width at 100% when over cap", () => {
    act(() => {
      root.render(createElement(BudgetMeterPill, { costUsd: 8, cap: 5 }));
    });
    const pill = container.querySelector('[data-testid="budget-meter"]') as HTMLElement;
    const bar = pill.querySelector("span[aria-hidden]") as HTMLElement;
    expect(bar.className).toContain("bg-err");
    expect(bar.style.width).toBe("100%");
  });
});
