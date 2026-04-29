import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Transcript } from "./Transcript.js";

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

describe("Transcript wrap prop", () => {
  it("default mount renders inner-only (no panel wrapper, no collapse button)", () => {
    act(() => {
      root.render(createElement(Transcript, { events: [] }));
    });
    expect(container.querySelector('[data-panel="transcript"]')).toBeNull();
    expect(container.querySelector('[data-testid="transcript-collapse"]')).toBeNull();
    expect(container.querySelector('[role="tablist"][aria-label="Transcript view"]')).not.toBeNull();
  });

  it("wrap=true mount renders standalone wrapper with collapse button", () => {
    act(() => {
      root.render(createElement(Transcript, { events: [], wrap: true }));
    });
    expect(container.querySelector('[data-panel="transcript"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="transcript-collapse"]')).not.toBeNull();
  });
});
