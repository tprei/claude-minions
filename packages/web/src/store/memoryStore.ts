import { create } from "zustand";
import type { Memory } from "../types.js";

interface MemoryStore {
  byConnection: Map<string, Map<string, Memory>>;
  replaceAll: (connId: string, memories: Memory[]) => void;
  upsert: (connId: string, memory: Memory) => void;
  remove: (connId: string, id: string) => void;
}

export const EMPTY_MEMORIES: Map<string, Memory> = new Map();

function withSlice(
  byConnection: Map<string, Map<string, Memory>>,
  connId: string,
  mutator: (slice: Map<string, Memory>) => void,
): Map<string, Map<string, Memory>> {
  const next = new Map(byConnection);
  const existing = next.get(connId);
  const slice = existing ? new Map(existing) : new Map<string, Memory>();
  mutator(slice);
  next.set(connId, slice);
  return next;
}

export const useMemoryStore = create<MemoryStore>((set) => ({
  byConnection: new Map(),

  replaceAll(connId, memories) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.clear();
        for (const m of memories) slice.set(m.id, m);
      }),
    }));
  },

  upsert(connId, memory) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.set(memory.id, memory);
      }),
    }));
  },

  remove(connId, id) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.delete(id);
      }),
    }));
  },
}));
