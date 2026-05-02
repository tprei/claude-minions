import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { VersionInfo } from "@minions/shared";
import { RepoTabs } from "../RepoTabs.js";
import { useConnectionStore } from "../../connections/store.js";
import { useVersionStore } from "../../store/version.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN_ID = "conn-test";

let container: HTMLDivElement;
let root: Root;

function makeVersionInfo(repos: { id: string; label: string }[]): VersionInfo {
  return {
    apiVersion: "1.0",
    libraryVersion: "0.0.1",
    features: [],
    featuresPending: [],
    provider: "test",
    providers: ["test"],
    repos,
    startedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useConnectionStore.setState({ activeId: CONN_ID });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  useConnectionStore.setState({ activeId: null });
  useVersionStore.setState({ byConnection: new Map() });
});

function tabLabels(): string[] {
  return Array.from(container.querySelectorAll('[role="tab"]')).map(
    (el) => (el.textContent ?? "").trim(),
  );
}

describe("RepoTabs", () => {
  it("renders nothing when only one repo is registered", () => {
    useVersionStore.getState().setVersion(
      CONN_ID,
      makeVersionInfo([{ id: "repo-1", label: "repo-1" }]),
    );
    act(() => {
      root.render(createElement(RepoTabs, { filterRepo: null, onFilterRepo: vi.fn() }));
    });
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it("renders All + each repo when multiple repos are registered", () => {
    useVersionStore.getState().setVersion(
      CONN_ID,
      makeVersionInfo([
        { id: "repo-1", label: "repo-1" },
        { id: "repo-2", label: "repo-2" },
      ]),
    );
    act(() => {
      root.render(createElement(RepoTabs, { filterRepo: null, onFilterRepo: vi.fn() }));
    });
    expect(tabLabels()).toEqual(["All", "repo-1", "repo-2"]);
  });

  it("marks the active tab via aria-selected", () => {
    useVersionStore.getState().setVersion(
      CONN_ID,
      makeVersionInfo([
        { id: "repo-1", label: "repo-1" },
        { id: "repo-2", label: "repo-2" },
      ]),
    );
    act(() => {
      root.render(createElement(RepoTabs, { filterRepo: "repo-2", onFilterRepo: vi.fn() }));
    });
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
    const selected = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    expect(selected?.textContent?.trim()).toBe("repo-2");
  });

  it("invokes onFilterRepo with the clicked repo id", () => {
    useVersionStore.getState().setVersion(
      CONN_ID,
      makeVersionInfo([
        { id: "repo-1", label: "repo-1" },
        { id: "repo-2", label: "repo-2" },
      ]),
    );
    const onFilterRepo = vi.fn();
    act(() => {
      root.render(createElement(RepoTabs, { filterRepo: null, onFilterRepo }));
    });
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
    const repo2 = tabs.find((t) => t.textContent?.trim() === "repo-2");
    act(() => {
      repo2?.click();
    });
    expect(onFilterRepo).toHaveBeenCalledWith("repo-2");
  });

  it("invokes onFilterRepo with null for the All tab", () => {
    useVersionStore.getState().setVersion(
      CONN_ID,
      makeVersionInfo([
        { id: "repo-1", label: "repo-1" },
        { id: "repo-2", label: "repo-2" },
      ]),
    );
    const onFilterRepo = vi.fn();
    act(() => {
      root.render(createElement(RepoTabs, { filterRepo: "repo-1", onFilterRepo }));
    });
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
    const allTab = tabs.find((t) => t.textContent?.trim() === "All");
    act(() => {
      allTab?.click();
    });
    expect(onFilterRepo).toHaveBeenCalledWith(null);
  });
});
