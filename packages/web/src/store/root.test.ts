import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Connection } from "../connections/store.js";
import { useConnectionStore } from "../connections/store.js";
import { attachConnection } from "./connectionState.js";
import { registerIntent, clear } from "./optimistic.js";
import { useRootStore } from "./root.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const connectionState = vi.hoisted(() => ({
  closeFns: new Map<string, ReturnType<typeof vi.fn>>(),
  attachConnection: vi.fn((conn: Connection) => {
    const close = vi.fn();
    connectionState.closeFns.set(conn.id, close);
    return close;
  }),
}));

vi.mock("./connectionState.js", () => ({
  attachConnection: connectionState.attachConnection,
}));

const localConn: Connection = {
  id: "local",
  label: "Local",
  baseUrl: "http://localhost:3000",
  token: "",
  color: "#7c5cff",
};

const staleConn: Connection = {
  id: "stale",
  label: "Stale",
  baseUrl: "http://localhost:3949",
  token: "",
  color: "#f87171",
};

afterEach(() => {
  useConnectionStore.setState({ connections: [], activeId: null, _hydrated: true });
  useRootStore.setState({ activeConnection: null });
  clear();
  vi.clearAllMocks();
  connectionState.closeFns.clear();
});

function ActiveLabel() {
  const conn = useRootStore((s) => s.getActiveConnection());
  return createElement("span", { "data-testid": "active-label" }, conn?.label ?? "none");
}

describe("root connection sync", () => {
  it("attaches every configured connection and disposes removed ones", () => {
    useConnectionStore.setState({
      connections: [localConn, staleConn],
      activeId: "local",
      _hydrated: true,
    });

    expect(attachConnection).toHaveBeenCalledTimes(2);
    expect(attachConnection).toHaveBeenNthCalledWith(1, localConn, 0);
    expect(attachConnection).toHaveBeenNthCalledWith(2, staleConn, 0);

    useConnectionStore.setState({
      connections: [staleConn],
      activeId: "stale",
      _hydrated: true,
    });

    expect(connectionState.closeFns.get("local")).toHaveBeenCalledOnce();
    expect(connectionState.closeFns.get("stale")).not.toHaveBeenCalled();
    expect(attachConnection).toHaveBeenCalledTimes(2);
  });

  it("rerenders selectors when the active connection changes", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      useConnectionStore.setState({
        connections: [localConn, staleConn],
        activeId: "local",
        _hydrated: true,
      });

      act(() => {
        root.render(createElement(ActiveLabel));
      });

      expect(container.textContent).toBe("Local");

      act(() => {
        useConnectionStore.setState({
          connections: [localConn, staleConn],
          activeId: "stale",
          _hydrated: true,
        });
      });

      expect(container.textContent).toBe("Stale");
    } finally {
      act(() => root.unmount());
      document.body.removeChild(container);
    }
  });

  it("uses the production active connection resolver for optimistic rollbacks", () => {
    vi.useFakeTimers();
    try {
      const rollback = vi.fn();
      useConnectionStore.setState({
        connections: [localConn],
        activeId: "local",
        _hydrated: true,
      });

      registerIntent(
        { connId: "local", description: "test", rollback },
        { timeoutMs: 1000, pillDelayMs: 1000 },
      );

      vi.advanceTimersByTime(1000);

      expect(rollback).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
