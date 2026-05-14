import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement, useCallback, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../hooks/useFeature.js", () => ({
  useFeature: () => false,
}));

import { ChatInput } from "../Input.js";
import { HelpModal } from "../HelpModal.js";
import { dispatchSlashUi } from "../ChatSurface.js";
import type { SlashCommand, SlashContext } from "../slashCommands.js";

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
  el.selectionStart = value.length;
  el.selectionEnd = value.length;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function fireKeyDown(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

interface HarnessProps {
  postCommand: ReturnType<typeof vi.fn>;
}

function Harness({ postCommand }: HarnessProps): ReactElement {
  const [helpOpen, setHelpOpen] = useState(false);

  const handleSlashCommand = useCallback(
    async (cmd: SlashCommand, args: string[]) => {
      const ctx: SlashContext = { workflowId: "wf-1", taskId: "task-1" };
      const result = cmd.build(args, ctx);
      if (result.kind === "command") {
        postCommand(result.payload);
      } else if (result.kind === "ui") {
        dispatchSlashUi(result.action, {
          openHelp: () => setHelpOpen(true),
          openCost: () => {},
        });
      }
    },
    [postCommand],
  );

  return createElement(
    "div",
    null,
    createElement(ChatInput, {
      onSubmit: () => {},
      onSlashCommand: handleSlashCommand,
    }),
    helpOpen ? createElement(HelpModal, { onClose: () => setHelpOpen(false) }) : null,
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

  it("/clear + Enter dispatches continue-task with text '/clear'", async () => {
    const postCommand = vi.fn();
    act(() => {
      root.render(createElement(Harness, { postCommand }));
    });
    await flush();

    await typeAndEnter("/clear");

    expect(postCommand).toHaveBeenCalledTimes(1);
    expect(postCommand).toHaveBeenCalledWith({
      kind: "continue-task",
      workflowId: "wf-1",
      taskId: "task-1",
      prompt: "/clear",
    });
  });

  it("/help + Enter renders the HelpModal listing all command rows", async () => {
    const postCommand = vi.fn();
    act(() => {
      root.render(createElement(Harness, { postCommand }));
    });
    await flush();

    await typeAndEnter("/help");

    for (const name of ["clear", "cost", "compact", "help", "retry", "land"]) {
      const row = container.querySelector(`[data-testid="help-row-${name}"]`);
      expect(row, `expected /${name} row in HelpModal`).not.toBeNull();
    }
  });
});
