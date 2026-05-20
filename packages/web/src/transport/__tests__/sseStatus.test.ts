import { describe, expect, it, vi } from "vitest";
import { createSseStatusStore } from "../sseStatus.js";

describe("sseStatusStore", () => {
  it("aggregates per-workflow status for a connection", () => {
    const store = createSseStatusStore();

    store.set("conn-1:wf-a", "open");
    store.set("conn-1:wf-b", "connecting");
    expect(store.get("conn-1")).toBe("connecting");

    store.set("conn-1:wf-b", "reconnecting");
    expect(store.get("conn-1")).toBe("reconnecting");

    store.set("conn-1:wf-a", "down");
    expect(store.get("conn-1")).toBe("down");
  });

  it("forces every workflow reconnect for a connection", () => {
    const store = createSseStatusStore();
    const first = vi.fn();
    const second = vi.fn();
    const other = vi.fn();

    store.registerReconnect("conn-1:wf-a", first);
    store.registerReconnect("conn-1:wf-b", second);
    store.registerReconnect("conn-2:wf-c", other);

    expect(store.forceReconnect("conn-1")).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it("keeps multiple reconnect handlers for the same workflow key and unregisters them individually", () => {
    const store = createSseStatusStore();
    const first = vi.fn();
    const second = vi.fn();

    store.registerReconnect("conn-1:wf-a", first);
    store.registerReconnect("conn-1:wf-a", second);

    expect(store.forceReconnect("conn-1:wf-a")).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    store.unregisterReconnect("conn-1:wf-a", first);
    first.mockClear();
    second.mockClear();

    expect(store.forceReconnect("conn-1:wf-a")).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    store.unregisterReconnect("conn-1:wf-a", second);
    expect(store.forceReconnect("conn-1:wf-a")).toBe(false);
  });
});
