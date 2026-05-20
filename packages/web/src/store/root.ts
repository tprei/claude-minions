import { create } from "zustand";
import { useConnectionStore, type Connection } from "../connections/store.js";
import { attachConnection } from "./connectionState.js";
import { setActiveConnIdResolver } from "./optimistic.js";

interface RootStore {
  activeConnection: Connection | null;
  getActiveConnection: () => Connection | null;
}

function resolveActiveConnection(connections: Connection[], activeId: string | null): Connection | null {
  if (!activeId) return null;
  return connections.find(c => c.id === activeId) ?? null;
}

export const useRootStore = create<RootStore>((_set, get) => ({
  activeConnection: resolveActiveConnection(
    useConnectionStore.getState().connections,
    useConnectionStore.getState().activeId,
  ),
  getActiveConnection() {
    return get().activeConnection;
  },
}));

setActiveConnIdResolver(() => useConnectionStore.getState().activeId);

const _disposeMap = new Map<string, { conn: Connection; dispose: () => void }>();

function shouldReplaceAttached(prev: Connection, next: Connection): boolean {
  return prev.baseUrl !== next.baseUrl || prev.token !== next.token;
}

function syncActiveConnection(connections: Connection[], activeId: string | null): void {
  const activeConn = resolveActiveConnection(connections, activeId);
  useRootStore.setState({ activeConnection: activeConn });

  const currentById = new Map(connections.map((conn) => [conn.id, conn]));
  for (const [id, attached] of _disposeMap) {
    const current = currentById.get(id);
    if (!current || shouldReplaceAttached(attached.conn, current)) {
      attached.dispose();
      _disposeMap.delete(id);
    }
  }

  for (const conn of connections) {
    if (_disposeMap.has(conn.id)) continue;
    const dispose = attachConnection(conn, 0);
    _disposeMap.set(conn.id, { conn, dispose });
  }
}

useConnectionStore.subscribe(state => {
  syncActiveConnection(state.connections, state.activeId);
});
