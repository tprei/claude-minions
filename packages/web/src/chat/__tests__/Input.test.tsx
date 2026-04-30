import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const { listRepoFilesMock } = vi.hoisted(() => ({
  listRepoFilesMock: vi.fn(),
}));

vi.mock("../../transport/rest.js", () => ({
  listRepoFiles: listRepoFilesMock,
  uploadAttachment: vi.fn(async () => ({ url: "x", name: "x", mimeType: "x", byteSize: 0 })),
}));

vi.mock("../../store/root.js", () => ({
  useRootStore: Object.assign(
    (selector: (s: { getActiveConnection: () => { id: string; baseUrl: string; token: string } }) => unknown) =>
      selector({ getActiveConnection: () => ({ id: "c1", baseUrl: "http://x", token: "t" }) }),
    {
      getState: () => ({
        getActiveConnection: () => ({ id: "c1", baseUrl: "http://x", token: "t" }),
      }),
    },
  ),
}));

vi.mock("../../hooks/useFeature.js", () => ({
  useFeature: () => false,
}));

import { ChatInput } from "../Input.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  listRepoFilesMock.mockClear();
  listRepoFilesMock.mockResolvedValue({ items: ["src/utils.ts", "src/user.ts"] });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
});

function setTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.selectionStart = value.length;
  el.selectionEnd = value.length;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function waitForMention(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function popoverItems(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("ul button")) as HTMLButtonElement[];
}

describe("ChatInput @-mention autocomplete", () => {
  it("renders matching files when the user types @u", async () => {
    act(() => {
      root.render(
        createElement(ChatInput, {
          onSubmit: vi.fn(),
          onSlashCommand: vi.fn(),
          repoId: "r1",
        }),
      );
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    act(() => setTextareaValue(textarea, "@u"));
    await waitForMention();

    expect(listRepoFilesMock).toHaveBeenCalled();
    const items = popoverItems();
    const texts = items.map((b) => b.textContent ?? "");
    expect(texts.some((t) => t.includes("utils.ts"))).toBe(true);
    expect(texts.some((t) => t.includes("user.ts"))).toBe(true);
  });

  it("ArrowDown + Enter inserts the second file and closes the popover", async () => {
    act(() => {
      root.render(
        createElement(ChatInput, {
          onSubmit: vi.fn(),
          onSlashCommand: vi.fn(),
          repoId: "r1",
        }),
      );
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setTextareaValue(textarea, "@u"));
    await waitForMention();
    expect(popoverItems().length).toBeGreaterThan(0);

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(textarea.value).toBe("@src/user.ts ");
    expect(popoverItems().length).toBe(0);
  });

  it("Escape closes the popover", async () => {
    act(() => {
      root.render(
        createElement(ChatInput, {
          onSubmit: vi.fn(),
          onSlashCommand: vi.fn(),
          repoId: "r1",
        }),
      );
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setTextareaValue(textarea, "@"));
    await waitForMention();
    expect(popoverItems().length).toBeGreaterThan(0);

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(popoverItems().length).toBe(0);
  });
});
