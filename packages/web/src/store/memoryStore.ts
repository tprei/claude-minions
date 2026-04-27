import { create } from "zustand";
import type { Memory } from "../types.js";

interface MemoryStore {
  memories: Map<string, Memory>;
  replaceAll: (memories: Memory[]) => void;
  upsert: (memory: Memory) => void;
  remove: (id: string) => void;
}

export const useMemoryStore = create<MemoryStore>((set) => ({
  memories: new Map(),

  replaceAll(memories) {
    const map = new Map<string, Memory>();
    for (const m of memories) map.set(m.id, m);
    set({ memories: map });
  },

  upsert(memory) {
    set(s => {
      const memories = new Map(s.memories);
      memories.set(memory.id, memory);
      return { memories };
    });
  },

  remove(id) {
    set(s => {
      const memories = new Map(s.memories);
      memories.delete(id);
      return { memories };
    });
  },
}));
