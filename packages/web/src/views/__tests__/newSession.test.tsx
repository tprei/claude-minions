import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { VersionInfo } from "@minions/shared";
import type { Workflow } from "@minions/engine-next";
import { NewSessionView } from "../newSession.js";
import { useConnectionStore } from "../../connections/store.js";
import { useVersionStore } from "../../store/version.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { createWorkflowMock } = vi.hoisted(() => ({
  createWorkflowMock: vi.fn(async (_conn: unknown, _spec: unknown): Promise<Workflow> => ({
    id: "wf-new",
    kind: "single-task",
    status: "active",
    graph: {
      "task-1": {
        id: "task-1",
        workflowId: "wf-new",
        title: "t",
        prompt: "p",
        executionStatus: "pending",
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
  })),
}));

vi.mock("../../transport/rest.js", () => ({
  createWorkflow: createWorkflowMock,
  apiFetch: vi.fn(),
}));

vi.mock("../../store/workflowStore.js", () => ({
  useWorkflowStore: Object.assign(
    vi.fn(() => ({})),
    { getState: () => ({ upsert: vi.fn() }) },
  ),
}));

vi.mock("../../routing/urlState.js", () => ({
  setUrlState: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

const CONN_ID = "conn-test";

const TEST_CONN = {
  id: CONN_ID,
  label: "Test",
  baseUrl: "http://localhost:9999",
  token: "tok",
  color: "#7c5cff",
};

function makeVersionInfo(): VersionInfo {
  return {
    apiVersion: "1.0",
    libraryVersion: "0.0.1",
    features: [],
    featuresPending: [],
    provider: "test",
    providers: ["test"],
    repos: [],
    startedAt: new Date().toISOString(),
  };
}

function setReactValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) throw new Error("no value setter");
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  createWorkflowMock.mockClear();
  useConnectionStore.setState({ activeId: CONN_ID, connections: [TEST_CONN], _hydrated: true });
  useVersionStore.getState().setVersion(CONN_ID, makeVersionInfo());
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  useConnectionStore.setState({ activeId: null, connections: [] });
  useVersionStore.setState({ byConnection: new Map(), workflowVersions: new Map() });
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeApi() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  };
}

describe("NewSessionView", () => {
  it("renders the prompt textarea and submit button", async () => {
    act(() => {
      root.render(createElement(NewSessionView, { api: makeApi() }));
    });
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();

    const submit = container.querySelector("button[type='submit']") as HTMLButtonElement | null;
    expect(submit).not.toBeNull();
  });

  it("calls createWorkflow when form is submitted with a valid prompt", async () => {
    act(() => {
      root.render(createElement(NewSessionView, { api: makeApi() }));
    });
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setReactValue(textarea, "do something useful here");
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(createWorkflowMock).toHaveBeenCalledTimes(1);
    const [, spec] = createWorkflowMock.mock.calls[0]! as [unknown, { tasks: { prompt: string }[] }];
    expect(spec.tasks[0]?.prompt).toBe("do something useful here");
  });

  it("disables submit when prompt is too short", async () => {
    act(() => {
      root.render(createElement(NewSessionView, { api: makeApi() }));
    });
    await flush();

    const submit = container.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setReactValue(textarea, "hi");
    });
    expect(submit.disabled).toBe(true);
  });
});
