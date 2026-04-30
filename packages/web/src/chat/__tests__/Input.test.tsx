import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement, useCallback, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ChatInput } from "../Input.js";
import { HelpModal } from "../HelpModal.js";
import { CostModal } from "../CostModal.js";
import { dispatchSlashUi } from "../ChatSurface.js";
import type { SlashCommand, SlashContext } from "../slashCommands.js";

vi.mock("../../store/root.js", () => ({
  useRootStore: Object.assign(
    (selector: (s: { getActiveConnection: () => null }) => unknown) =>
      selector({ getActiveConnection: () => null }),
    { getState: () => ({ getActiveConnection: () => null }) },
  ),
}));

vi.mock("../../hooks/useFeature.js", () => ({
  useFeature: () => false,
}));

vi.mock("../../transport/rest.js", () => ({
  uploadAttachment: vi.fn(async () => ({ url: "stub://uploaded" })),
}));

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

function setReactValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function fireKeyDown(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

const STUB_SESSION = {
  slug: "sess-1",
  title: "test",
  prompt: "",
  mode: "task" as const,
  status: "waiting_input" as const,
  childSlugs: [],
  attention: [],
  quickActions: [],
  stats: {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.42,
    durationMs: 0,
    toolCalls: 0,
  },
  provider: "test",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  metadata: {},
  costBudgetUsd: 2,
};

interface HarnessProps {
  postCommand: ReturnType<typeof vi.fn>;
}

function Harness({ postCommand }: HarnessProps): ReactElement {
  const [helpOpen, setHelpOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("transcript");

  const handleSlashCommand = useCallback(
    async (cmd: SlashCommand, args: string[]) => {
      const ctx: SlashContext = { sessionSlug: STUB_SESSION.slug };
      const result = cmd.build(args, ctx);
      if (result.kind === "command") {
        postCommand(result.payload);
      } else if (result.kind === "ui") {
        dispatchSlashUi(result.action, {
          activeId: null,
          openConfig: () => {},
          openHelp: () => setHelpOpen(true),
          openCost: () => setCostOpen(true),
          setActiveTab,
        });
      }
    },
    [postCommand],
  );

  return createElement(
    "div",
    null,
    createElement("div", { "data-testid": "active-tab" }, activeTab),
    createElement(ChatInput, {
      onSubmit: () => {},
      onSlashCommand: handleSlashCommand,
    }),
    helpOpen ? createElement(HelpModal, { onClose: () => setHelpOpen(false) }) : null,
    costOpen
      ? createElement(CostModal, { session: STUB_SESSION, onClose: () => setCostOpen(false) })
      : null,
  );
}

function findTextarea(): HTMLTextAreaElement {
  const el = container.querySelector("textarea");
  if (!el) throw new Error("textarea not found");
  return el as HTMLTextAreaElement;
}

async function typeAndEnter(value: string): Promise<void> {
  const ta = findTextarea();
  act(() => setReactValue(ta, value));
  await flush();
  // First Enter accepts the autocomplete (rewrites value to "/<name> "), the
  // second Enter submits the command since the popover is now closed.
  act(() => fireKeyDown(ta, "Enter"));
  await flush();
  act(() => fireKeyDown(ta, "Enter"));
  await flush();
}

describe("ChatInput slash popover", () => {
  it("lists /cost and /compact when typing /co", async () => {
    const postCommand = vi.fn();
    act(() => {
      root.render(createElement(Harness, { postCommand }));
    });
    await flush();
    const ta = findTextarea();
    act(() => setReactValue(ta, "/co"));
    await flush();

    const popoverText = container.textContent ?? "";
    expect(popoverText).toContain("/cost");
    expect(popoverText).toContain("/compact");
  });

  it("/clear + Enter dispatches a reply command with text '/clear'", async () => {
    const postCommand = vi.fn();
    act(() => {
      root.render(createElement(Harness, { postCommand }));
    });
    await flush();

    await typeAndEnter("/clear");

    expect(postCommand).toHaveBeenCalledTimes(1);
    expect(postCommand).toHaveBeenCalledWith({
      kind: "reply",
      sessionSlug: STUB_SESSION.slug,
      text: "/clear",
    });
  });

  it("/cost + Enter renders the CostModal", async () => {
    const postCommand = vi.fn();
    act(() => {
      root.render(createElement(Harness, { postCommand }));
    });
    await flush();

    await typeAndEnter("/cost");

    const modal = container.querySelector('[data-testid="cost-value"]');
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toBe("$0.42");
    expect(postCommand).not.toHaveBeenCalled();
  });

  it("/diff + Enter switches the active tab to diff", async () => {
    const postCommand = vi.fn();
    act(() => {
      root.render(createElement(Harness, { postCommand }));
    });
    await flush();

    await typeAndEnter("/diff");

    const tab = container.querySelector('[data-testid="active-tab"]');
    expect(tab?.textContent).toBe("diff");
  });

  it("/help + Enter renders the HelpModal listing all command rows", async () => {
    const postCommand = vi.fn();
    act(() => {
      root.render(createElement(Harness, { postCommand }));
    });
    await flush();

    await typeAndEnter("/help");

    for (const name of ["clear", "cost", "diff", "compact", "help"]) {
      const row = container.querySelector(`[data-testid="help-row-${name}"]`);
      expect(row, `expected /${name} row in HelpModal`).not.toBeNull();
    }
  });
});
