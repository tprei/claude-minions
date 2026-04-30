import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InputDialog } from "../InputDialog.js";

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

function getInput(): HTMLInputElement {
  const input = document.querySelector("input[type=number]") as HTMLInputElement | null;
  if (!input) throw new Error("number input not rendered");
  return input;
}

function getButtons(): { cancel: HTMLButtonElement; confirm: HTMLButtonElement } {
  const buttons = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
  const cancel = buttons.find((b) => b.textContent === "Cancel");
  const confirm = buttons.find((b) => b.textContent !== "Cancel");
  if (!cancel || !confirm) throw new Error("buttons not rendered");
  return { cancel, confirm };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("InputDialog", () => {
  it("renders title, label, and initial value", () => {
    act(() => {
      root.render(
        createElement(InputDialog, {
          open: true,
          title: "Set budget",
          label: "Budget (USD)",
          initialValue: 5,
          onConfirm: () => {},
          onCancel: () => {},
        }),
      );
    });
    expect(document.body.textContent).toContain("Set budget");
    expect(document.body.textContent).toContain("Budget (USD)");
    expect(getInput().value).toBe("5");
  });

  it("parses number, invokes onConfirm with the parsed value, and shows pending", async () => {
    let resolveFn: (() => void) | null = null;
    const onConfirm = vi.fn(
      (_v: number) =>
        new Promise<void>((resolve) => {
          resolveFn = resolve;
        }),
    );
    const onCancel = vi.fn();
    act(() => {
      root.render(
        createElement(InputDialog, {
          open: true,
          title: "Set budget",
          label: "Budget",
          initialValue: 1,
          confirmLabel: "Resume",
          onConfirm,
          onCancel,
        }),
      );
    });
    act(() => {
      setInputValue(getInput(), "3.25");
    });
    act(() => {
      getButtons().confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledWith(3.25);
    const { confirm } = getButtons();
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe("Working…");
    act(() => {
      resolveFn?.();
    });
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("invokes onCancel without calling onConfirm when Cancel is clicked", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      root.render(
        createElement(InputDialog, {
          open: true,
          title: "Set budget",
          label: "Budget",
          initialValue: 2,
          onConfirm,
          onCancel,
        }),
      );
    });
    act(() => {
      getButtons().cancel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables confirm when input is empty or invalid", () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        createElement(InputDialog, {
          open: true,
          title: "Set budget",
          label: "Budget",
          onConfirm,
          onCancel: () => {},
        }),
      );
    });
    expect(getButtons().confirm.disabled).toBe(true);
    act(() => {
      setInputValue(getInput(), "abc");
    });
    expect(getButtons().confirm.disabled).toBe(true);
    act(() => {
      getButtons().confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
