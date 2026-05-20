import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Workflow } from "@minions/engine";
import { ListView } from "../list.js";
import { useConnectionStore } from "../../connections/store.js";
import { useWorkflowStore } from "../../store/workflowStore.js";
import { useVersionStore } from "../../store/version.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN_ID = "conn-list";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useConnectionStore.setState({
    activeId: CONN_ID,
    connections: [],
  });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  useConnectionStore.setState({ activeId: null, connections: [] });
  useWorkflowStore.setState({ byConnection: new Map() });
  useVersionStore.setState({ byConnection: new Map() });
});

function makeWorkflow(id: string, repoId: string, title: string): Workflow {
  const now = `2026-01-01T00:00:0${id.slice(-1)}Z`;
  return {
    id,
    kind: "single-task",
    repoId,
    status: "active",
    graph: {
      [`${id}:task`]: {
        id: `${id}:task`,
        workflowId: id,
        title,
        prompt: title,
        dependsOn: [],
        executionStatus: "running",
        stackStatus: "clean",
        priority: 0,
        claims: [],
        contract: { summary: title, expectedArtifacts: [] },
        artifacts: [],
        runs: [],
        readiness: "unknown",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    },
    operations: {},
    policy: { maxConcurrent: 1, autoLand: false, autoMergeOnGreen: false },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

describe("ListView", () => {
  it("filters rows by repo id", () => {
    useWorkflowStore.getState().replaceAll(CONN_ID, [
      makeWorkflow("wf-1", "repo-a", "Repo A task"),
      makeWorkflow("wf-2", "repo-b", "Repo B task"),
    ]);

    act(() => {
      root.render(
        createElement(ListView, {
          filterRepo: "repo-b",
          onFilterRepo: vi.fn(),
        }),
      );
    });

    expect(container.textContent).not.toContain("Repo A task");
    expect(container.textContent).toContain("Repo B task");
  });
});
