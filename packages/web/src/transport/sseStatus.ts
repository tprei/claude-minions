// Module-level subscribable so any component can show the SSE status without prop drilling.

export type SseStatus = "connecting" | "open" | "reconnecting" | "down";

export interface SseStatusStore {
  get(connectionId: string): SseStatus | undefined;
  set(connectionId: string, status: SseStatus): void;
  clear(connectionId: string): void;
  registerReconnect(connectionId: string, fn: () => void): void;
  forceReconnect(connectionId: string): boolean;
  unregisterReconnect(connectionId: string): void;
  subscribe(listener: () => void): () => void;
}

export function createSseStatusStore(): SseStatusStore {
  const map = new Map<string, SseStatus>();
  const reconnectFns = new Map<string, () => void>();
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
    registerReconnect(connectionId, fn) {
      reconnectFns.set(connectionId, fn);
    },
    forceReconnect(connectionId) {
      const fn = reconnectFns.get(connectionId);
      if (!fn) return false;
      fn();
      return true;
    },
    unregisterReconnect(connectionId) {
      reconnectFns.delete(connectionId);
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
