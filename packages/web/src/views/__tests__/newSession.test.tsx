import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Session, VersionInfo } from "@minions/shared";
import { NewSessionView } from "../newSession.js";
import { useConnectionStore } from "../../connections/store.js";
import { useVersionStore } from "../../store/version.js";
import { useSessionStore } from "../../store/sessionStore.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const CONN_ID = "conn-test";

function makeVersionInfo(): VersionInfo {
  return {
    apiVersion: "1.0",
    libraryVersion: "0.0.1",
    features: [],
    featuresPending: [],
    provider: "test",
    providers: ["test"],
    repos: [
      { id: "repo-1", label: "repo-1" },
      { id: "repo-2", label: "repo-2" },
    ],
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

function makeSession(slug: string): Session {
  return {
    slug,
    title: "t",
    prompt: "p",
    mode: "task",
    status: "pending",
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
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useConnectionStore.setState({ activeId: CONN_ID });
  useVersionStore.getState().setVersion(CONN_ID, makeVersionInfo());
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  useConnectionStore.setState({ activeId: null });
  useVersionStore.setState({ byConnection: new Map() });
  useSessionStore.setState({ byConnection: new Map() });
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeApi(postReturn: Session) {
  const post = vi.fn(async (_path: string, _body: unknown) => postReturn as unknown);
  return {
    get: vi.fn(),
    post,
    patch: vi.fn(),
    del: vi.fn(),
  };
}

function getInput(label: string): HTMLInputElement {
  const labels = Array.from(container.querySelectorAll("label")) as HTMLLabelElement[];
  const found = labels.find((l) => l.textContent?.includes(label));
  if (!found) throw new Error(`label not found: ${label}`);
  const input = found.parentElement?.querySelector("input, textarea") as HTMLInputElement | null;
  if (!input) throw new Error(`input not found for label ${label}`);
  return input;
}

describe("NewSessionView budget field", () => {
  it("submits costBudgetUsd when budget input is filled", async () => {
    const api = makeApi(makeSession("new-1"));
    act(() => {
      root.render(createElement(NewSessionView, { api }));
    });
    await flush();

    act(() => {
      setReactValue(getInput("Prompt"), "do something useful");
      setReactValue(getInput("Budget"), "2.5");
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post.mock.calls[0]![0]).toBe("/api/sessions");
    const body = api.post.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.costBudgetUsd).toBe(2.5);
  });

  it("defaults repoId to filterRepo when it matches a known repo", async () => {
    const api = makeApi(makeSession("new-3"));
    act(() => {
      root.render(createElement(NewSessionView, { api, filterRepo: "repo-2" }));
    });
    await flush();

    act(() => {
      setReactValue(getInput("Prompt"), "do another thing");
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    const body = api.post.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.repoId).toBe("repo-2");
  });

  it("falls back to first repo when filterRepo is null", async () => {
    const api = makeApi(makeSession("new-4"));
    act(() => {
      root.render(createElement(NewSessionView, { api, filterRepo: null }));
    });
    await flush();

    act(() => {
      setReactValue(getInput("Prompt"), "do another thing");
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    const body = api.post.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.repoId).toBe("repo-1");
  });

  it("omits costBudgetUsd when blank", async () => {
    const api = makeApi(makeSession("new-2"));
    act(() => {
      root.render(createElement(NewSessionView, { api }));
    });
    await flush();

    act(() => {
      setReactValue(getInput("Prompt"), "do another thing");
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(api.post).toHaveBeenCalledTimes(1);
    const body = api.post.mock.calls[0]![1] as Record<string, unknown>;
    expect("costBudgetUsd" in body).toBe(false);
  });
});
