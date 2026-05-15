import { create } from "zustand";
import { useConnectionStore, type Connection } from "../connections/store.js";
import { attachConnection } from "./connectionState.js";

interface RootStore {
  getActiveConnection: () => Connection | null;
}

export const useRootStore = create<RootStore>(() => ({
  getActiveConnection() {
    const { connections, activeId } = useConnectionStore.getState();
    if (!activeId) return null;
    return connections.find(c => c.id === activeId) ?? null;
  },
}));

const _disposeMap = new Map<string, { conn: Connection; dispose: () => void }>();

function shouldReplaceAttached(prev: Connection, next: Connection): boolean {
  return prev.baseUrl !== next.baseUrl || prev.token !== next.token;
}

function syncActiveConnection(connections: Connection[], activeId: string | null): void {
  const activeConn = activeId ? connections.find(c => c.id === activeId) ?? null : null;

  for (const [id, attached] of _disposeMap) {
    if (!activeConn || id !== activeConn.id || shouldReplaceAttached(attached.conn, activeConn)) {
      attached.dispose();
      _disposeMap.delete(id);
    }
  }

  if (activeConn && !_disposeMap.has(activeConn.id)) {
    const dispose = attachConnection(activeConn, 0);
    _disposeMap.set(activeConn.id, { conn: activeConn, dispose });
  }
}

useConnectionStore.subscribe(state => {
  syncActiveConnection(state.connections, state.activeId);
});
