import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Command, Session } from "@minions/shared";

vi.mock("../../transport/rest.js", () => ({
  getReadiness: vi.fn(async () => null),
  getCheckpoints: vi.fn(async () => ({ items: [] })),
  restoreCheckpoint: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../store/root.js", () => ({
  useRootStore: Object.assign(
    (selector: (s: { getActiveConnection: () => null }) => unknown) =>
      selector({ getActiveConnection: () => null }),
    {
      getState: () => ({ getActiveConnection: () => null }),
    },
  ),
}));

import { RecoveryFooter } from "../RecoveryFooter.js";

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

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    slug: "sess-1",
    title: "test session",
    prompt: "do work",
    mode: "task",
    status: "waiting_input",
    childSlugs: [],
    attention: [],
    quickActions: [],
    stats: {
      turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, costUsd: 0, durationMs: 0, toolCalls: 0,
    },
    provider: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

function setReactValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function findButtonByText(text: string): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
  return buttons.find((b) => b.textContent?.trim() === text) ?? null;
}

describe("RecoveryFooter budget_exceeded action", () => {
  it("renders Resume-with-new-cap action when budget_exceeded flag is present", async () => {
    const session = makeSession({
      status: "running",
      attention: [
        {
          kind: "budget_exceeded",
          message: "Cost cap reached",
          raisedAt: new Date().toISOString(),
        },
      ],
      costBudgetUsd: 2,
    });
    const onAction = vi.fn(async () => {});

    act(() => {
      root.render(createElement(RecoveryFooter, { session, onAction }));
    });
    await flush();

    expect(findButtonByText("Resume with new cap")).not.toBeNull();
  });

  it("omits Resume-with-new-cap when budget_exceeded is absent", async () => {
    const session = makeSession({ status: "running", attention: [{ kind: "needs_input", message: "x", raisedAt: new Date().toISOString() }] });
    const onAction = vi.fn(async () => {});

    act(() => {
      root.render(createElement(RecoveryFooter, { session, onAction }));
    });
    await flush();

    expect(findButtonByText("Resume with new cap")).toBeNull();
  });

  it("Retry on a failed session dispatches both reply and resume-session so the queue is kicked", async () => {
    const session = makeSession({ status: "failed" });
    const calls: Command[] = [];
    const onAction = vi.fn(async (cmd: Command) => {
      calls.push(cmd);
    });

    act(() => {
      root.render(createElement(RecoveryFooter, { session, onAction }));
    });
    await flush();

    const retry = findButtonByText("Retry");
    expect(retry).not.toBeNull();
    act(() => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    await flush();

    expect(calls).toEqual([
      { kind: "reply", sessionSlug: "sess-1", text: "Please retry the last action." },
      { kind: "resume-session", sessionSlug: "sess-1" },
    ]);
  });

  it("confirming InputDialog posts update-session-budget command", async () => {
    const session = makeSession({
      status: "running",
      attention: [
        {
          kind: "budget_exceeded",
          message: "Cost cap reached",
          raisedAt: new Date().toISOString(),
        },
      ],
      costBudgetUsd: 2,
    });
    const calls: Command[] = [];
    const onAction = vi.fn(async (cmd: Command) => {
      calls.push(cmd);
    });

    act(() => {
      root.render(createElement(RecoveryFooter, { session, onAction }));
    });
    await flush();

    act(() => {
      findButtonByText("Resume with new cap")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();

    const input = document.querySelector("input[type=number]") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("2");

    act(() => {
      setReactValue(input, "10");
    });

    const confirmBtn = findButtonByText("Resume");
    expect(confirmBtn).not.toBeNull();
    act(() => {
      confirmBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(calls).toEqual([
      {
        kind: "update-session-budget",
        slug: "sess-1",
        costBudgetUsd: 10,
      },
    ]);
  });
});
