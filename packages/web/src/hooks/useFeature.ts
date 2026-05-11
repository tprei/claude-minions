/**
 * Feature-gate hook. In the new engine all features are always enabled;
 * the old feature-flag mechanism via engine-next doesn't exist.
 * This hook is preserved so call sites in surviving components compile
 * without change — it unconditionally returns true.
 */
export function useFeature(_feature: string): boolean {
  return true;
}
