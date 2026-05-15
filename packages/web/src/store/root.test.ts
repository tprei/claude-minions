import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../connections/store.js";
import { useConnectionStore } from "../connections/store.js";
import { attachConnection } from "./connectionState.js";
import "./root.js";

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
  vi.clearAllMocks();
  connectionState.closeFns.clear();
});

describe("root connection sync", () => {
  it("attaches SSE only for the active connection", () => {
    useConnectionStore.setState({
      connections: [localConn, staleConn],
      activeId: "local",
      _hydrated: true,
    });

    expect(attachConnection).toHaveBeenCalledTimes(1);
    expect(attachConnection).toHaveBeenLastCalledWith(localConn, 0);

    useConnectionStore.setState({
      connections: [localConn, staleConn],
      activeId: "stale",
      _hydrated: true,
    });

    expect(connectionState.closeFns.get("local")).toHaveBeenCalledOnce();
    expect(attachConnection).toHaveBeenCalledTimes(2);
    expect(attachConnection).toHaveBeenLastCalledWith(staleConn, 0);
  });
});
