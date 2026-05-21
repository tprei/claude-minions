import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Connection } from "./connections/store.js";
import { useConnectionStore } from "./connections/store.js";
import { useWorkflowStore } from "./store/workflowStore.js";

const routeState = vi.hoisted(() => ({
  current: {
    connectionId: "conn-b",
    view: "list" as const,
    sessionSlug: undefined as string | undefined,
    query: {},
  },
}));

const urlStateSpies = vi.hoisted(() => ({
  setUrlState: vi.fn(),
  replaceUrlState: vi.fn(),
}));

vi.mock("./views/layout.js", () => ({
  AppLayout: ({ header, sidebar, main, chatSurface }: {
    header: unknown;
    sidebar: ((opts: { closeMobile: () => void }) => unknown) | unknown;
    main: unknown;
    chatSurface?: unknown;
  }) => createElement("div", null,
    header as never,
    typeof sidebar === "function" ? sidebar({ closeMobile: () => {} }) as never : sidebar as never,
    main as never,
    chatSurface as never),
}));

vi.mock("./views/header.js", () => ({ Header: () => createElement("div", null, "header") }));
vi.mock("./views/sidebar.js", () => ({ Sidebar: () => createElement("div", null, "sidebar") }));
vi.mock("./components/Spinner.js", () => ({ Spinner: () => createElement("div", null, "spinner") }));
vi.mock("./components/CommandPalette.js", () => ({ CommandPalette: () => null }));
vi.mock("./components/CommandPalette.actions.js", () => ({ buildActions: () => [] }));
vi.mock("./views/ViewSwitcher.js", () => ({ ViewSwitcher: () => createElement("div", null, "view") }));
vi.mock("./chat/ChatSurface.js", () => ({ ChatSurface: () => createElement("div", null, "chat") }));
vi.mock("./pwa/install.js", () => ({ initInstallPrompt: vi.fn() }));
vi.mock("./pwa/offline.js", () => ({ initOfflineDetection: vi.fn() }));
vi.mock("./pwa/OfflineBanner.js", () => ({ OfflineBanner: () => null }));
vi.mock("./pwa/InstallButton.js", () => ({ InstallButton: () => null }));
vi.mock("./pwa/sw.js", () => ({ registerServiceWorker: vi.fn() }));
vi.mock("./pwa/UpdateBanner.js", () => ({ UpdateBanner: () => null }));
vi.mock("./transport/rest.js", () => ({ apiFetch: vi.fn() }));
vi.mock("./store/connectionState.js", () => ({ attachConnection: vi.fn(() => () => {}) }));
vi.mock("./routing/parseUrl.js", () => ({
  parseUrl: () => routeState.current,
}));
vi.mock("./routing/urlState.js", () => ({
  subscribeUrlChanges: () => () => {},
  setUrlState: urlStateSpies.setUrlState,
  replaceUrlState: urlStateSpies.replaceUrlState,
}));

import { App } from "./App.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONN_A: Connection = {
  id: "conn-a",
  label: "A",
  baseUrl: "http://a.local",
  token: "a",
  color: "#111111",
};

const CONN_B: Connection = {
  id: "conn-b",
  label: "B",
  baseUrl: "http://b.local",
  token: "b",
  color: "#222222",
};

describe("App route connection sync", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    urlStateSpies.setUrlState.mockReset();
    urlStateSpies.replaceUrlState.mockReset();
    useWorkflowStore.setState({ byConnection: new Map() });
    useConnectionStore.setState({
      connections: [CONN_A, CONN_B],
      activeId: "conn-a",
      _hydrated: true,
    });
    routeState.current = {
      connectionId: "conn-b",
      view: "list",
      sessionSlug: undefined,
      query: {},
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
    useWorkflowStore.setState({ byConnection: new Map() });
    useConnectionStore.setState({ connections: [], activeId: null, _hydrated: false });
  });

  it("activates the connection encoded in the URL on mount", () => {
    act(() => {
      root.render(createElement(App));
    });

    expect(useConnectionStore.getState().activeId).toBe("conn-b");
  });

  it("does not render active connection data for an unknown route connection id", () => {
    routeState.current = {
      connectionId: "missing-conn",
      view: "list",
      sessionSlug: "wf-1",
      query: { repo: "repo-1" },
    };

    act(() => {
      root.render(createElement(App));
    });

    expect(container.textContent).toBe("spinner");
    expect(urlStateSpies.replaceUrlState).toHaveBeenCalledWith({
      connectionId: "conn-a",
      view: "list",
      sessionSlug: "wf-1",
      query: { repo: "repo-1" },
    });
    expect(useConnectionStore.getState().activeId).toBe("conn-a");
  });
});
