import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useConnectionStore, type Connection } from "./store.js";
import { ConnectionPicker, QrConfirmDialog } from "./picker.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("idb-keyval", () => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

const localConn: Connection = {
  id: "local",
  label: "Local",
  baseUrl: "http://localhost:3000",
  token: "",
  color: "#7c5cff",
};

const staleConn: Connection = {
  id: "stale",
  label: "Stale",
  baseUrl: "http://localhost:3949",
  token: "",
  color: "#f87171",
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  window.history.replaceState(null, "", "/c/local/list/wf-1");
  useConnectionStore.setState({
    connections: [localConn, staleConn],
    activeId: "local",
    _hydrated: true,
  });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  useConnectionStore.setState({ connections: [], activeId: null, _hydrated: false });
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((el) => el.textContent === text);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ConnectionPicker", () => {
  it("removes an active connection and moves selection to the next connection", async () => {
    act(() => {
      root.render(createElement(ConnectionPicker, { onClose: vi.fn() }));
    });

    act(() => {
      document.querySelector<HTMLButtonElement>("[data-testid=picker-remove-local]")?.click();
    });

    expect(document.body.textContent).toContain("Remove connection?");
    expect(document.body.textContent).toContain("http://localhost:3000");

    act(() => {
      buttonByText("Remove").click();
    });
    await flush();

    const state = useConnectionStore.getState();
    expect(state.connections.map((conn) => conn.id)).toEqual(["stale"]);
    expect(state.activeId).toBe("stale");
    expect(window.location.pathname).toBe("/c/stale/list");
  });
});

describe("QrConfirmDialog", () => {
  it("blocks submit and shows an error when the edited baseUrl is not http(s)", () => {
    const addSpy = vi.spyOn(useConnectionStore.getState(), "add");
    const onAdded = vi.fn();

    act(() => {
      root.render(createElement(QrConfirmDialog, {
        candidate: {
          label: "Scanned",
          baseUrl: "http://localhost:3000",
          token: "secret",
          color: "#7c5cff",
        },
        onAdded,
        onClose: vi.fn(),
      }));
    });

    const baseUrlInput = document.querySelector<HTMLInputElement>("[data-testid=qr-confirm-base-url]");
    if (!baseUrlInput) throw new Error("base url input not found");

    act(() => {
      setInputValue(baseUrlInput, "ftp://evil.example");
    });

    act(() => {
      document.querySelector<HTMLFormElement>("[data-testid=qr-confirm-form]")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(addSpy).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("baseUrl must use http or https");
  });
});
