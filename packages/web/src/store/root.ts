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

const _disposeMap = new Map<string, () => void>();

function syncConnections(connections: Connection[]): void {
  const removedIds = [..._disposeMap.keys()].filter(id => !connections.find(c => c.id === id));
  for (const id of removedIds) {
    _disposeMap.get(id)?.();
    _disposeMap.delete(id);
  }

  const newConns = connections.filter(c => !_disposeMap.has(c.id));
  newConns.forEach((conn, idx) => {
    const delay = idx * 250;
    const dispose = attachConnection(conn, delay);
    _disposeMap.set(conn.id, dispose);
  });
}

useConnectionStore.subscribe(state => {
  syncConnections(state.connections);
});
