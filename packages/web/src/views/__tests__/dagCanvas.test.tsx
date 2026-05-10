import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TaskNode } from "@minions/engine";
import { useConnectionStore } from "../../connections/store.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const setUrlStateMock = vi.fn();

vi.mock("../../routing/urlState.js", () => ({
  setUrlState: (...args: unknown[]) => setUrlStateMock(...args),
}));

vi.mock("reactflow", () => ({
  Handle: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
}));

const { DagNodeComponent } = await import("../dagCanvas.js");

const TEST_CONN = {
  id: "conn-1",
  label: "Test",
  baseUrl: "http://localhost:9999",
  token: "tok",
  color: "#7c5cff",
};

let container: HTMLDivElement;
let root: Root;

function makeTask(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: "task-1",
    workflowId: "wf-1",
    title: "Plan thing",
    prompt: "do the thing",
    executionStatus: "ready",
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
    sessionId: "session-alpha",
    ...overrides,
  };
}

function setActiveConnection(): void {
  useConnectionStore.setState({
    connections: [TEST_CONN],
    activeId: TEST_CONN.id,
    _hydrated: true,
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  setUrlStateMock.mockReset();
  setActiveConnection();
  globalThis.history.replaceState(null, "", `/c/${TEST_CONN.id}/dag`);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  useConnectionStore.setState({ connections: [], activeId: null, _hydrated: true });
});

describe("DagNodeComponent session link", () => {
  it("renders the view button when sessionId is present", async () => {
    const task = makeTask({ sessionId: "session-alpha" });

    await act(async () => {
      root.render(
        createElement(DagNodeComponent, {
          id: task.id,
          type: "dagNode",
          data: { task },
          selected: false,
          isConnectable: true,
          xPos: 0,
          yPos: 0,
          dragging: false,
          zIndex: 0,
        } as unknown as Parameters<typeof DagNodeComponent>[0]),
      );
    });

    const btn = container.querySelector(
      '[data-testid="dag-node-session-link"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.className).toContain("nodrag");
    expect(btn!.className).toContain("cursor-pointer");
  });

  it("clicking the link navigates via setUrlState", async () => {
    const task = makeTask({ sessionId: "session-alpha" });

    await act(async () => {
      root.render(
        createElement(DagNodeComponent, {
          id: task.id,
          type: "dagNode",
          data: { task },
          selected: false,
          isConnectable: true,
          xPos: 0,
          yPos: 0,
          dragging: false,
          zIndex: 0,
        } as unknown as Parameters<typeof DagNodeComponent>[0]),
      );
    });

    const btn = container.querySelector(
      '[data-testid="dag-node-session-link"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();

    await act(async () => {
      btn?.click();
    });

    expect(setUrlStateMock).toHaveBeenCalledTimes(1);
    expect(setUrlStateMock.mock.calls[0]![0]).toMatchObject({
      connectionId: TEST_CONN.id,
    });
  });

  it("does not render the session link when sessionId is absent", async () => {
    const task = makeTask({ sessionId: undefined });

    await act(async () => {
      root.render(
        createElement(DagNodeComponent, {
          id: task.id,
          type: "dagNode",
          data: { task },
          selected: false,
          isConnectable: true,
          xPos: 0,
          yPos: 0,
          dragging: false,
          zIndex: 0,
        } as unknown as Parameters<typeof DagNodeComponent>[0]),
      );
    });

    expect(
      container.querySelector('[data-testid="dag-node-session-link"]'),
    ).toBeNull();
  });
});
