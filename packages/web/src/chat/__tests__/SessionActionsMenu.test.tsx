import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Workflow } from "@minions/engine";
import type { Connection } from "../../connections/store.js";

vi.mock("../../transport/rest.js", () => ({
  dispatchCommand: vi.fn(async () => ({ ok: true })),
  deleteWorkflow: vi.fn(async () => ({ ok: true })),
}));

const workflowStoreState = vi.hoisted(() => ({
  remove: vi.fn(),
}));

vi.mock("../../store/workflowStore.js", () => ({
  useWorkflowStore: Object.assign(
    vi.fn(),
    { getState: () => workflowStoreState },
  ),
}));

vi.mock("../../connections/store.js", () => ({
  useConnectionStore: Object.assign(
    vi.fn((sel: (s: { activeId: string | null }) => unknown) => sel({ activeId: "other-active" })),
    { getState: () => ({ activeId: "other-active" }) },
  ),
}));

import { SessionActionsMenu } from "../SessionActionsMenu.js";
import { deleteWorkflow, dispatchCommand } from "../../transport/rest.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(dispatchCommand).mockClear();
  vi.mocked(deleteWorkflow).mockClear();
  workflowStoreState.remove.mockClear();
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

function makeWorkflow(status: Workflow["status"] = "active"): Workflow {
  return {
    id: "wf-1",
    kind: "single-task",
    repoId: "fixture-repo",
    status,
    graph: {
      "task-1": {
        id: "task-1",
        workflowId: "wf-1",
        title: "Test Task",
        prompt: "do work",
        executionStatus: status === "active" ? "running" : "completed",
        stackStatus: "clean",
        dependsOn: [],
        priority: 0,
        claims: [],
        contract: { summary: "", expectedArtifacts: [] },
        artifacts: [],
        runs: [],
        readiness: "unknown",
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
    operations: {},
    policy: { maxConcurrent: 3, autoLand: false, autoMergeOnGreen: false },
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function findTrigger(parent: ParentNode = container): HTMLButtonElement {
  const el = parent.querySelector(
    "button[aria-label='Task actions']",
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
  it("for an active workflow, popover shows {Cancel, Remove}", () => {
    const workflow = makeWorkflow("active");
    act(() => {
      root.render(
        createElement(SessionActionsMenu, { workflow, conn: TEST_CONN }),
      );
    });
    clickTrigger();
    const labels = menuItemLabels();
    expect(labels).toContain("Cancel");
    expect(labels).toContain("Remove…");
    expect(labels).toHaveLength(2);
  });

  it("for a completed workflow, popover shows only {Remove}", () => {
    const workflow = makeWorkflow("completed");
    act(() => {
      root.render(
        createElement(SessionActionsMenu, { workflow, conn: TEST_CONN }),
      );
    });
    clickTrigger();
    const labels = menuItemLabels();
    expect(labels).toEqual(["Remove…"]);
  });

  it("clicking the trigger does NOT propagate to a parent click handler", () => {
    const parentSpy = vi.fn();
    act(() => {
      root.render(
        createElement(
          "div",
          { onClick: parentSpy, "data-testid": "parent" },
          createElement(SessionActionsMenu, {
            workflow: makeWorkflow(),
            conn: TEST_CONN,
          }),
        ),
      );
    });
    clickTrigger();
    expect(parentSpy).not.toHaveBeenCalled();
  });

  it("confirms cancel with cancel-task transition", async () => {
    const workflow = makeWorkflow("active");
    act(() => {
      root.render(
        createElement(SessionActionsMenu, { workflow, conn: TEST_CONN }),
      );
    });
    clickTrigger();
    const cancel = Array.from(document.querySelectorAll("[role='menuitem']")).find(
      (el) => el.textContent?.trim() === "Cancel",
    ) as HTMLButtonElement | undefined;
    act(() => {
      cancel?.click();
    });
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (el) => el.textContent?.trim() === "Cancel task",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      confirm?.click();
    });

    expect(dispatchCommand).toHaveBeenCalledWith(TEST_CONN, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: {
        kind: "cancel-task",
        taskId: "task-1",
        now: expect.any(String),
      },
    });
  });

  it("removes from the rendered connection slice after delete confirmation", async () => {
    const workflow = makeWorkflow("active");
    act(() => {
      root.render(
        createElement(SessionActionsMenu, { workflow, conn: TEST_CONN }),
      );
    });
    clickTrigger();
    const remove = Array.from(document.querySelectorAll("[role='menuitem']")).find(
      (el) => el.textContent?.trim() === "Remove…",
    ) as HTMLButtonElement | undefined;
    act(() => {
      remove?.click();
    });
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (el) => el.textContent?.trim() === "Remove",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      confirm?.click();
    });

    expect(deleteWorkflow).toHaveBeenCalledWith(TEST_CONN, "wf-1");
    expect(workflowStoreState.remove).toHaveBeenCalledWith(TEST_CONN.id, "wf-1");
  });
});
