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

  function scopedKeys(connectionId: string): string[] {
    const prefix = `${connectionId}:`;
    return [...map.keys()].filter((key) => key.startsWith(prefix));
  }

  function aggregate(connectionId: string): SseStatus | undefined {
    const direct = map.get(connectionId);
    if (direct !== undefined) return direct;
    const statuses = scopedKeys(connectionId).map((key) => map.get(key)).filter((v): v is SseStatus => v !== undefined);
    if (statuses.length === 0) return undefined;
    if (statuses.includes("down")) return "down";
    if (statuses.includes("reconnecting")) return "reconnecting";
    if (statuses.includes("connecting")) return "connecting";
    return "open";
  }

  function notify(): void {
    for (const l of listeners) l();
  }

  return {
    get(connectionId) {
      return aggregate(connectionId);
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
      if (fn) {
        fn();
        return true;
      }
      const prefix = `${connectionId}:`;
      const scoped = [...reconnectFns.entries()].filter(([key]) => key.startsWith(prefix));
      for (const [, reconnect] of scoped) reconnect();
      return scoped.length > 0;
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
