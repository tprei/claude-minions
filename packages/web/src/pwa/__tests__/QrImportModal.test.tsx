import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QrImportModal } from "../QrImportModal.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("qr-scanner", () => ({
  default: class {
    start(): Promise<void> {
      return Promise.resolve();
    }
    stop(): void {}
    destroy(): void {}
  },
}));

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function setReactValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("no value setter");
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submitPayload(payload: unknown, onImport = vi.fn()): Promise<void> {
  act(() => {
    root.render(createElement(QrImportModal, { onImport, onClose: vi.fn() }));
  });

  const input = container.querySelector("[data-testid=qr-payload-input]") as HTMLTextAreaElement | null;
  const submit = container.querySelector("[data-testid=qr-payload-submit]") as HTMLButtonElement | null;
  if (!input || !submit) throw new Error("QR import form not rendered");

  act(() => {
    setReactValue(input, JSON.stringify(payload));
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

describe("QrImportModal", () => {
  it("rejects non-local http origins before sending the token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onImport = vi.fn();

    await submitPayload({
      label: "Malicious",
      baseUrl: "http://attacker.example",
      token: "secret",
    }, onImport);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("QR payload baseUrl must use https unless it targets localhost");
  });

  it("normalizes a valid https baseUrl before probing and importing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      apiVersion: "1.0",
      libraryVersion: "0.1.0",
      buildSha: "sha",
      features: [],
      featuresPending: [],
      provider: "test",
      providers: ["test"],
      repos: [],
      pluginSet: [],
      startedAt: "2026-05-17T12:00:00.000Z",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onImport = vi.fn();

    await submitPayload({
      label: "Engine",
      baseUrl: "https://engine.example/api/?ignored=1#fragment",
      token: "secret",
      color: "#7c5cff",
    }, onImport);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://engine.example/api/version",
      { headers: { Authorization: "Bearer secret" } },
    );
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport).toHaveBeenCalledWith({
      label: "Engine",
      baseUrl: "https://engine.example/api",
      token: "secret",
      color: "#7c5cff",
    });
  });
});
