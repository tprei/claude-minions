import { useConnectionStore } from "../connections/store.js";
import { useVersionStore } from "../store/version.js";

export function useFeature(feature: string): boolean {
  const activeId = useConnectionStore((state) => state.activeId);
  return useVersionStore((state) => {
    if (activeId === null) return false;
    return state.byConnection.get(activeId)?.features.includes(feature) ?? false;
  });
}
