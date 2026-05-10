import { create } from "zustand";

/**
 * Resource store — stubbed.
 *
 * The legacy engine emitted periodic `resource` SSE events carrying
 * ResourceSnapshot (CPU/memory/disk). The new engine-next transport only
 * emits WorkflowEvents; there is no resource telemetry channel. This store
 * is kept as an empty stub so that downstream components (resource/) compile
 * until step 6-7 rewrites them.
 */

export const RESOURCE_HISTORY_MAX = 60;

export interface ResourceEntry {
  ts: number;
}

interface ResourceStore {
  byConnection: Map<string, ResourceEntry[]>;
}

export const useResourceStore = create<ResourceStore>(() => ({
  byConnection: new Map(),
}));
