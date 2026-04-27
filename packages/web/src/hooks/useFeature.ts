import type { FeatureFlag } from "../types.js";
import { useConnectionStore } from "../connections/store.js";
import { useVersionStore } from "../store/version.js";

export function useFeature(name: FeatureFlag): boolean {
  const activeId = useConnectionStore(s => s.activeId);
  const byConnection = useVersionStore(s => s.byConnection);
  if (!activeId) return false;
  const info = byConnection.get(activeId);
  if (!info) return false;
  return info.features.includes(name);
}
