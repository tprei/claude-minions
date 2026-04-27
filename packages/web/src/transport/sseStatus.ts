// Module-level subscribable so any component can show the SSE status without prop drilling.

export type SseStatus = "connecting" | "open" | "reconnecting";

export interface SseStatusStore {
  get(connectionId: string): SseStatus | undefined;
  set(connectionId: string, status: SseStatus): void;
  clear(connectionId: string): void;
  subscribe(listener: () => void): () => void;
}

export function createSseStatusStore(): SseStatusStore {
  const map = new Map<string, SseStatus>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const l of listeners) l();
  }

  return {
    get(connectionId) {
      return map.get(connectionId);
    },
    set(connectionId, status) {
      if (map.get(connectionId) === status) return;
      map.set(connectionId, status);
      notify();
    },
    clear(connectionId) {
      if (!map.has(connectionId)) return;
      map.delete(connectionId);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const sseStatusStore = createSseStatusStore();
