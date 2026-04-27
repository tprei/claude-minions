import { create } from "zustand";
import type { ResourceSnapshot } from "../types.js";

interface ResourceStore {
  snapshot: ResourceSnapshot | null;
  push: (snapshot: ResourceSnapshot) => void;
}

export const useResourceStore = create<ResourceStore>((set) => ({
  snapshot: null,

  push(snapshot) {
    set({ snapshot });
  },
}));
