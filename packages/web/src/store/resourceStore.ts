import { create } from "zustand";
import type { ResourceSnapshot } from "../types.js";

interface ResourceStore {
  byConnection: Map<string, ResourceSnapshot>;
  push: (connId: string, snapshot: ResourceSnapshot) => void;
}

export const useResourceStore = create<ResourceStore>((set) => ({
  byConnection: new Map(),

  push(connId, snapshot) {
    set(s => {
      const byConnection = new Map(s.byConnection);
      byConnection.set(connId, snapshot);
      return { byConnection };
    });
  },
}));
