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
}));
