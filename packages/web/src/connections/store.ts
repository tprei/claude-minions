import { create } from "zustand";
import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";

export interface Connection {
  id: string;
  label: string;
  baseUrl: string;
  token: string;
  color: string;
}

interface ConnectionStore {
  connections: Connection[];
  activeId: string | null;
  _hydrated: boolean;
  add: (conn: Omit<Connection, "id">) => Connection;
  update: (id: string, patch: Partial<Omit<Connection, "id">>) => void;
  remove: (id: string) => void;
  setActive: (id: string | null) => void;
  hydrate: () => Promise<void>;
}

function nanoid(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

const IDB_KEY = "connections.v1";

async function persist(connections: Connection[]): Promise<void> {
  await idbSet(IDB_KEY, connections);
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  connections: [],
  activeId: null,
  _hydrated: false,

  add(conn) {
    const id = nanoid();
    const full: Connection = { ...conn, id };
    set(s => {
      const connections = [...s.connections, full];
      void persist(connections);
      return { connections };
    });
    return full;
  },

  update(id, patch) {
    set(s => {
      const connections = s.connections.map(c => c.id === id ? { ...c, ...patch } : c);
      void persist(connections);
      return { connections };
    });
  },

  remove(id) {
    set(s => {
      const connections = s.connections.filter(c => c.id !== id);
      const activeId = s.activeId === id ? (connections[0]?.id ?? null) : s.activeId;
      void persist(connections);
      void idbDel(`snap:${id}`);
      return { connections, activeId };
    });
  },

  setActive(id) {
    set({ activeId: id });
  },

  async hydrate() {
    if (get()._hydrated) return;
    const stored = await idbGet<Connection[]>(IDB_KEY);
    const connections = stored ?? [];
    const activeId = connections[0]?.id ?? null;
    set({ connections, activeId, _hydrated: true });
  },
}));
