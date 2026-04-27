import type { EventBus } from "../bus/eventBus.js";

export function listenForVariantCompletions(
  parentSlug: string,
  expectedSlugs: string[],
  bus: EventBus,
  onAllDone: (completedSlugs: string[]) => void,
  timeoutMs = 30 * 60 * 1000,
): () => void {
  const completed = new Set<string>();
  const expected = new Set(expectedSlugs);
  let settled = false;

  const handle = setTimeout(() => {
    if (settled) return;
    settled = true;
    unsubscribe();
    onAllDone([...completed]);
  }, timeoutMs);

  const unsubscribe = bus.on("session_updated", (evt) => {
    if (!expected.has(evt.session.slug)) return;
    const status = evt.session.status;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      completed.add(evt.session.slug);
    }
    if (completed.size >= expected.size) {
      if (settled) return;
      settled = true;
      clearTimeout(handle);
      unsubscribe();
      onAllDone([...completed]);
    }
  });

  return () => {
    if (!settled) {
      settled = true;
      clearTimeout(handle);
      unsubscribe();
    }
  };
}
