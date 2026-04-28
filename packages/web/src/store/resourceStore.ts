import { create } from "zustand";
import type { ResourceSnapshot } from "../types.js";

export const RESOURCE_HISTORY_MAX = 60;

interface ResourceStore {
  byConnection: Map<string, ResourceSnapshot[]>;
  push: (connId: string, snapshot: ResourceSnapshot) => void;
  clear: (connId: string) => void;
}

export const useResourceStore = create<ResourceStore>((set) => ({
  byConnection: new Map(),

  push(connId, snapshot) {
    set(s => {
      const byConnection = new Map(s.byConnection);
      const prev = byConnection.get(connId) ?? [];
      const next = prev.length >= RESOURCE_HISTORY_MAX
        ? [...prev.slice(prev.length - RESOURCE_HISTORY_MAX + 1), snapshot]
        : [...prev, snapshot];
      byConnection.set(connId, next);
      return { byConnection };
    });
  },

  clear(connId) {
    set(s => {
      if (!s.byConnection.has(connId)) return s;
      const byConnection = new Map(s.byConnection);
      byConnection.delete(connId);
      return { byConnection };
    });
  },
}));
