import { create } from "zustand";
import type { VersionInfo } from "../types.js";

interface VersionStore {
  byConnection: Map<string, VersionInfo>;
  setVersion: (connId: string, info: VersionInfo) => void;
}

export const useVersionStore = create<VersionStore>((set) => ({
  byConnection: new Map(),

  setVersion(connId, info) {
    set(s => {
      const byConnection = new Map(s.byConnection);
      byConnection.set(connId, info);
      return { byConnection };
    });
  },
}));
