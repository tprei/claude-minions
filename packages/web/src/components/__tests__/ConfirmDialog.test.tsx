import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConfirmDialog } from "../ConfirmDialog.js";

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

function getButtons(): { cancel: HTMLButtonElement; confirm: HTMLButtonElement } {
  const buttons = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
  const cancel = buttons.find((b) => b.textContent === "Cancel");
  const confirm = buttons.find((b) => b.textContent !== "Cancel");
  if (!cancel || !confirm) throw new Error("buttons not rendered");
  return { cancel, confirm };
}

describe("ConfirmDialog", () => {
  it("renders title and body when open", () => {
    act(() => {
      root.render(
        createElement(ConfirmDialog, {
          open: true,
          onClose: () => {},
          onConfirm: () => Promise.resolve(),
          title: "Delete sessions?",
          body: createElement("p", { "data-testid": "body" }, "This will delete 4 sessions"),
          confirmLabel: "Delete 4 sessions",
        }),
      );
    });
    expect(document.body.textContent).toContain("Delete sessions?");
    expect(document.querySelector("[data-testid=body]")?.textContent).toBe(
      "This will delete 4 sessions",
    );
    expect(getButtons().confirm.textContent).toBe("Delete 4 sessions");
  });

  it("invokes onConfirm and closes on success", async () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    act(() => {
      root.render(
        createElement(ConfirmDialog, {
          open: true,
          onClose,
          onConfirm,
          title: "Confirm",
          body: "body",
          confirmLabel: "OK",
        }),
      );
    });
    act(() => {
      getButtons().confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("displays error banner when onConfirm rejects", async () => {
    const onConfirm = vi.fn(() => Promise.reject(new Error("boom")));
    const onClose = vi.fn();
    act(() => {
      root.render(
        createElement(ConfirmDialog, {
          open: true,
          onClose,
          onConfirm,
          title: "Confirm",
          body: "body",
          confirmLabel: "OK",
        }),
      );
    });
    act(() => {
      getButtons().confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).toContain("boom");
    expect(onClose).not.toHaveBeenCalled();
    const { cancel, confirm } = getButtons();
    expect(cancel.disabled).toBe(false);
    expect(confirm.disabled).toBe(false);
  });

  it("disables both buttons while pending", async () => {
    let resolveFn: (() => void) | null = null;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFn = resolve;
        }),
    );
    act(() => {
      root.render(
        createElement(ConfirmDialog, {
          open: true,
          onClose: () => {},
          onConfirm,
          title: "Confirm",
          body: "body",
          confirmLabel: "OK",
        }),
      );
    });
    act(() => {
      getButtons().confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const { cancel, confirm } = getButtons();
    expect(cancel.disabled).toBe(true);
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe("Working…");
    act(() => {
      resolveFn?.();
    });
    await flush();
  });
});
