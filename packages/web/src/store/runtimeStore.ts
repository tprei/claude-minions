import { create } from "zustand";
import type { RuntimeConfigSchema, RuntimeOverrides } from "../types.js";

interface RuntimeStore {
  schema: RuntimeConfigSchema | null;
  values: RuntimeOverrides;
  effective: RuntimeOverrides;
  replace: (schema: RuntimeConfigSchema, values: RuntimeOverrides, effective: RuntimeOverrides) => void;
}

export const useRuntimeStore = create<RuntimeStore>((set) => ({
  schema: null,
  values: {},
  effective: {},

  replace(schema, values, effective) {
    set({ schema, values, effective });
  },
}));
