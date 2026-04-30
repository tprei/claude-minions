import { create } from "zustand";
import type { RuntimeConfigSchema, RuntimeOverrides } from "../types.js";

export interface RuntimeSlice {
  schema: RuntimeConfigSchema | null;
  values: RuntimeOverrides;
  effective: RuntimeOverrides;
}

interface RuntimeStore {
  byConnection: Map<string, RuntimeSlice>;
  replace: (
    connId: string,
    schema: RuntimeConfigSchema,
    values: RuntimeOverrides,
    effective: RuntimeOverrides,
  ) => void;
  remove: (connId: string) => void;
}

export const useRuntimeStore = create<RuntimeStore>((set) => ({
  byConnection: new Map(),

  replace(connId, schema, values, effective) {
    set(s => {
      const byConnection = new Map(s.byConnection);
      byConnection.set(connId, { schema, values, effective });
      return { byConnection };
    });
  },

  remove(connId) {
    set(s => {
      if (!s.byConnection.has(connId)) return s;
      const byConnection = new Map(s.byConnection);
      byConnection.delete(connId);
      return { byConnection };
    });
  },
}));
