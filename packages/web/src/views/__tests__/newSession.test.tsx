import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { VersionInfo } from "@minions/shared";
import type { Workflow } from "@minions/engine";
import { NewSessionView } from "../newSession.js";
import { useConnectionStore } from "../../connections/store.js";
import { useVersionStore } from "../../store/version.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { createWorkflowMock, planWorkflowMock } = vi.hoisted(() => ({
  createWorkflowMock: vi.fn(async (_conn: unknown, _spec: unknown): Promise<Workflow> => ({
    id: "wf-new",
    kind: "single-task",
    repoId: "fixture-repo",
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
  planWorkflowMock: vi.fn(),
}));

vi.mock("../../transport/rest.js", () => {
  class ApiError extends Error {
    code: string;
    status: number;
    detail: undefined;
    constructor(status: number, body: { code: string; message: string }) {
      super(body.message);
      this.name = "ApiError";
      this.code = body.code;
      this.status = status;
    }
  }
  return {
    createWorkflow: createWorkflowMock,
    apiFetch: vi.fn(),
    ApiError,
    planWorkflow: planWorkflowMock,
  };
});

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
    buildSha: "test-sha",
    features: [],
    featuresPending: [],
    provider: "test",
    providers: ["test"],
    repos: [{ id: "fixture-repo", label: "fixture-repo", defaultBranch: "main" }],
    pluginSet: [],
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

const PLAN_RESPONSE = {
  spec: {
    id: "wf-plan-1",
    kind: "single-task",
    repoId: "fixture-repo",
    tasks: [{ id: "t-plan-1", title: "Planned task", prompt: "do something useful here" }],
  },
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  createWorkflowMock.mockClear();
  // Re-set planWorkflow implementation after clearMocks resets it
  planWorkflowMock.mockResolvedValue(PLAN_RESPONSE);
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
    for (let i = 0; i < 10; i++) await Promise.resolve();
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

  it("shows the plan preview modal when planWorkflow succeeds", async () => {

    act(() => {
      root.render(createElement(NewSessionView, { api: makeApi() }));
    });
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setReactValue(textarea, "do something useful here");
    });

    const planRadio = container.querySelector("input[type='radio'][value='plan']") as HTMLInputElement;
    expect(planRadio).not.toBeNull();
    await act(async () => {
      planRadio.click();
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      // Let planWorkflow mock resolve (microtask) + state update
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    // Extra flush for React re-render after state update
    await flush();

    // Verify planWorkflow was called
    expect(planWorkflowMock).toHaveBeenCalledTimes(1);

    // Modal should be open — use vi.waitFor to poll for the button (React re-render is async)
    await vi.waitFor(() => {
      const buttons = Array.from(container.querySelectorAll("button"));
      const confirm = buttons.find((b) => b.textContent?.includes("Confirm"));
      expect(confirm).toBeDefined();
    }, { timeout: 2000, interval: 10 });
  });

  it("calls createWorkflow when the plan modal is confirmed", async () => {
    act(() => {
      root.render(createElement(NewSessionView, { api: makeApi() }));
    });
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setReactValue(textarea, "do something useful here");
    });

    const planRadio = container.querySelector("input[type='radio'][value='plan']") as HTMLInputElement;
    expect(planRadio).not.toBeNull();
    await act(async () => {
      planRadio.click();
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      // Let planWorkflow mock resolve (microtask) + state update
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    // Extra flush for React re-render after state update
    await flush();

    // Click "Confirm & dispatch"
    const allButtons = Array.from(container.querySelectorAll("button"));
    const confirmDispatch = allButtons.find((b) => b.textContent?.includes("Confirm"));
    expect(confirmDispatch).toBeDefined();

    await act(async () => {
      confirmDispatch!.click();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    await flush();

    expect(createWorkflowMock).toHaveBeenCalledTimes(1);
    const [, spec] = createWorkflowMock.mock.calls[0]! as [unknown, { tasks: { prompt: string }[] }];
    expect(spec.tasks[0]?.prompt).toBe("do something useful here");
  });

  it("submitting in think mode creates a think-thread workflow with no mergeTarget", async () => {
    act(() => {
      root.render(createElement(NewSessionView, { api: makeApi() }));
    });
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      setReactValue(textarea, "what does the planner do exactly");
    });

    const thinkRadio = container.querySelector("input[type='radio'][value='think']") as HTMLInputElement;
    expect(thinkRadio).not.toBeNull();
    await act(async () => {
      thinkRadio.click();
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    await flush();

    expect(planWorkflowMock).not.toHaveBeenCalled();
    expect(createWorkflowMock).toHaveBeenCalledTimes(1);
    const [, spec] = createWorkflowMock.mock.calls[0]! as [unknown, {
      kind: string;
      tasks: { prompt: string; mergeTarget?: string }[];
    }];
    expect(spec.kind).toBe("think-thread");
    expect(spec.tasks[0]?.prompt).toBe("what does the planner do exactly");
    expect(spec.tasks[0]?.mergeTarget).toBeUndefined();
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
