import { create } from "zustand";

/**
 * Runtime config store — stubbed.
 *
 * The legacy engine exposed per-connection runtime override config via
 * GET /runtime-config (schema + values + effective overrides). The new
 * engine-next has no equivalent endpoint; operator config is static and
 * not exposed to the UI. This store is kept as an empty stub so that
 * downstream components (runtime/) compile until step 6-7 rewrites them.
 */

export interface RuntimeSlice {
  schema: null;
  values: Record<string, unknown>;
  effective: Record<string, unknown>;
}

interface RuntimeStore {
  byConnection: Map<string, RuntimeSlice>;
}

export const useRuntimeStore = create<RuntimeStore>(() => ({
  byConnection: new Map(),
}));
