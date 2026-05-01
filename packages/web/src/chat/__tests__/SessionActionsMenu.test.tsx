import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Session } from "@minions/shared";
import type { Connection } from "../../connections/store.js";

vi.mock("../../transport/rest.js", () => ({
  postCommand: vi.fn(async () => ({ ok: true })),
  deleteSession: vi.fn(async () => ({ ok: true })),
}));

import { SessionActionsMenu } from "../SessionActionsMenu.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

const TEST_CONN: Connection = {
  id: "c1",
  label: "Test",
  baseUrl: "http://localhost:9999",
  token: "t",
  color: "#7c5cff",
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    slug: "sess-1",
    title: "Test Session",
    prompt: "do work",
    mode: "task",
    status: "running",
    childSlugs: [],
    attention: [],
    quickActions: [],
    stats: {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
      toolCalls: 0,
    },
    provider: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

function findTrigger(parent: ParentNode = container): HTMLButtonElement {
  const el = parent.querySelector(
    "button[aria-label='Session actions']",
  ) as HTMLButtonElement | null;
  if (!el) throw new Error("trigger not rendered");
  return el;
}

function menuItemLabels(): string[] {
  const menu = document.querySelector("[role='menu']");
  if (!menu) return [];
  return Array.from(menu.querySelectorAll("[role='menuitem']")).map(
    (el) => el.textContent?.trim() ?? "",
  );
}

function clickTrigger(): void {
  act(() => {
    findTrigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("SessionActionsMenu", () => {
  it("for a running session, popover shows {Cancel, Delete}", () => {
    const session = makeSession({ status: "running" });
    act(() => {
      root.render(
        createElement(SessionActionsMenu, { session, conn: TEST_CONN }),
      );
    });
    clickTrigger();
    const labels = menuItemLabels();
    expect(labels).toContain("Cancel");
    expect(labels).toContain("Delete…");
    expect(labels).not.toContain("Close");
    expect(labels).toHaveLength(2);
  });

  it("for a completed session WITH worktreePath, popover shows {Close, Delete}", () => {
    const session = makeSession({
      status: "completed",
      worktreePath: "/tmp/wt",
    });
    act(() => {
      root.render(
        createElement(SessionActionsMenu, { session, conn: TEST_CONN }),
      );
    });
    clickTrigger();
    const labels = menuItemLabels();
    expect(labels).toContain("Close");
    expect(labels).toContain("Delete…");
    expect(labels).not.toContain("Cancel");
    expect(labels).toHaveLength(2);
  });

  it("for a completed session WITHOUT worktreePath, popover shows {Delete} only", () => {
    const session = makeSession({ status: "completed" });
    act(() => {
      root.render(
        createElement(SessionActionsMenu, { session, conn: TEST_CONN }),
      );
    });
    clickTrigger();
    const labels = menuItemLabels();
    expect(labels).toEqual(["Delete…"]);
  });

  it("clicking the trigger does NOT propagate to a parent click handler", () => {
    const parentSpy = vi.fn();
    act(() => {
      root.render(
        createElement(
          "div",
          { onClick: parentSpy, "data-testid": "parent" },
          createElement(SessionActionsMenu, {
            session: makeSession(),
            conn: TEST_CONN,
          }),
        ),
      );
    });
    clickTrigger();
    expect(parentSpy).not.toHaveBeenCalled();
    expect(menuItemLabels().length).toBeGreaterThan(0);
  });

  it("outside click closes the popover", () => {
    act(() => {
      root.render(
        createElement(SessionActionsMenu, {
          session: makeSession(),
          conn: TEST_CONN,
        }),
      );
    });
    clickTrigger();
    expect(menuItemLabels().length).toBeGreaterThan(0);

    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(document.querySelector("[role='menu']")).toBeNull();
  });
});
