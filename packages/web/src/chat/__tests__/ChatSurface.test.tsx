import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Connection } from "../../connections/store.js";
import { useConnectionStore } from "../../connections/store.js";
import { useWorkflowStore } from "../../store/workflowStore.js";

const stream = vi.hoisted(() => ({
  listeners: [] as Array<{ onEvent?: (event: unknown) => void; onReconnect?: () => void }>,
}));

const rest = vi.hoisted(() => ({
  dispatchCommand: vi.fn(),
  listTranscript: vi.fn(),
}));

vi.mock("../../store/connectionState.js", () => ({
  attachConnection: vi.fn(() => () => {}),
  subscribeWorkflowStream: vi.fn((_connId: string, _workflowId: string, listener: { onEvent?: (event: unknown) => void; onReconnect?: () => void }) => {
    stream.listeners.push(listener);
    return () => {
      const idx = stream.listeners.indexOf(listener);
      if (idx >= 0) stream.listeners.splice(idx, 1);
    };
  }),
}));

vi.mock("../../transport/rest.js", () => ({
  dispatchCommand: rest.dispatchCommand,
  listTranscript: rest.listTranscript,
}));

vi.mock("../../transcript/Transcript.js", () => ({
  Transcript: ({ events }: { events: Array<{ kind: string; text?: string; toolName?: string }> }) =>
    createElement(
      "div",
      { "data-testid": "transcript" },
      events.map((event) => event.text ?? event.toolName ?? event.kind).join("|"),
    ),
}));

vi.mock("../../chat/Input.js", () => ({
  ChatInput: () => createElement("div", null, "input"),
}));
vi.mock("../../chat/HelpModal.js", () => ({ HelpModal: () => null }));
vi.mock("../../chat/CostModal.js", () => ({ CostModal: () => null }));
vi.mock("../../components/ConfirmDialog.js", () => ({ ConfirmDialog: () => null }));
vi.mock("../../components/Sheet.js", () => ({ Sheet: ({ children }: { children: unknown }) => createElement("div", null, children as never) }));
vi.mock("../../components/ResizeHandle.js", () => ({ ResizeHandle: () => createElement("div", null, "resize") }));
vi.mock("../../components/Spinner.js", () => ({ Spinner: () => createElement("div", null, "spinner") }));
vi.mock("../../components/Button.js", () => ({
  Button: ({ children, onClick }: { children: unknown; onClick?: () => void }) =>
    createElement("button", { type: "button", onClick }, children as never),
}));
vi.mock("../../pwa/gestures.js", () => ({
  useSwipeToDismiss: () => {},
  hasScrollableAncestor: () => false,
}));
vi.mock("../../hooks/useMediaQuery.js", () => ({ useMediaQuery: () => false }));
vi.mock("../../routing/urlState.js", () => ({ setUrlState: vi.fn() }));
vi.mock("../../routing/parseUrl.js", () => ({
  parseUrl: () => ({ connectionId: "conn-1", view: "list", sessionSlug: undefined, query: {} }),
}));
vi.mock("../../util/panelLayout.js", () => ({
  getLayout: () => null,
  setLayout: vi.fn(),
  subscribe: () => () => {},
}));

import { ChatSurface } from "../ChatSurface.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN: Connection = {
  id: "conn-1",
  label: "Local",
  baseUrl: "http://engine.test",
  token: "token",
  color: "#34d399",
};

function makeWorkflow() {
  const now = "2026-05-20T00:00:00.000Z";
  return {
    id: "wf-1",
    kind: "single-task" as const,
    repoId: "fixture-repo",
    status: "active" as const,
    graph: {
      "wf-1:task": {
        id: "wf-1:task",
        workflowId: "wf-1",
        title: "Task",
        prompt: "Prompt",
        dependsOn: [],
        executionStatus: "running" as const,
        stackStatus: "clean" as const,
        priority: 0,
        claims: [],
        contract: { summary: "Task", expectedArtifacts: [] },
        artifacts: [],
        sessionId: "sess-1",
        runs: [
          {
            id: "run-1",
            taskId: "wf-1:task",
            attempt: 1,
            providerType: "stub",
            runtimeType: "stub",
            runtimeSessionId: "sess-1",
            startedAt: now,
          },
        ],
        readiness: "ready" as const,
        version: 2,
        createdAt: now,
        updatedAt: now,
      },
    },
    operations: {},
    policy: { maxConcurrent: 3, autoLand: false, autoMergeOnGreen: false },
    version: 2,
    createdAt: now,
    updatedAt: now,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ChatSurface workflow stream fan-out", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    stream.listeners = [];
    rest.dispatchCommand.mockReset();
    rest.listTranscript.mockReset();
    useConnectionStore.setState({
      connections: [CONN],
      activeId: CONN.id,
      _hydrated: true,
    });
    useWorkflowStore.setState({
      byConnection: new Map([[CONN.id, new Map([["wf-1", makeWorkflow()]])]]),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
    useWorkflowStore.setState({ byConnection: new Map() });
    useConnectionStore.setState({ connections: [], activeId: null, _hydrated: false });
  });

  it("refetches transcript on reconnect and appends live provider events from the shared stream", async () => {
    rest.listTranscript
      .mockResolvedValueOnce({
        transcript: [
          {
            occurredAt: "2026-05-20T00:00:01.000Z",
            providerEvent: { kind: "assistant_text", text: "seeded" },
          },
        ],
      })
      .mockResolvedValueOnce({
        transcript: [
          {
            occurredAt: "2026-05-20T00:00:01.000Z",
            providerEvent: { kind: "assistant_text", text: "seeded" },
          },
          {
            occurredAt: "2026-05-20T00:00:02.000Z",
            providerEvent: { kind: "assistant_text", text: "missed" },
          },
        ],
      });

    act(() => {
      root.render(createElement(ChatSurface, { sessionSlug: "wf-1" }));
    });
    await flush();

    expect(rest.listTranscript).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("seeded");

    const transcriptListener = stream.listeners.find((listener) => typeof listener.onReconnect === "function");
    expect(transcriptListener).toBeDefined();

    act(() => {
      transcriptListener?.onEvent?.({
        kind: "provider-event",
        workflowId: "wf-1",
        occurredAt: "2026-05-20T00:00:03.000Z",
        payload: {
          taskId: "wf-1:task",
          runId: "run-1",
          providerEvent: { kind: "assistant_text", text: "live" },
        },
      });
    });
    await flush();

    expect(container.textContent).toContain("live");

    await act(async () => {
      transcriptListener?.onReconnect?.();
      await Promise.resolve();
    });
    await flush();

    expect(rest.listTranscript).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("missed");
    expect(container.textContent).toContain("live");
  });
});
