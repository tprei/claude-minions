// Module-level subscribable so any component can show the SSE status without prop drilling.

export type SseStatus = "connecting" | "open" | "reconnecting" | "down";

export interface SseStatusStore {
  get(connectionId: string): SseStatus | undefined;
  set(connectionId: string, status: SseStatus): void;
  clear(connectionId: string): void;
  registerReconnect(connectionId: string, fn: () => void): void;
  forceReconnect(connectionId: string): boolean;
  unregisterReconnect(connectionId: string, fn: () => void): void;
  subscribe(listener: () => void): () => void;
}

export function createSseStatusStore(): SseStatusStore {
  const map = new Map<string, SseStatus>();
  const reconnectFns = new Map<string, Set<() => void>>();
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
      const existing = reconnectFns.get(connectionId);
      if (existing) {
        existing.add(fn);
        return;
      }
      reconnectFns.set(connectionId, new Set([fn]));
    },
    forceReconnect(connectionId) {
      const direct = reconnectFns.get(connectionId);
      if (direct && direct.size > 0) {
        for (const fn of direct) fn();
        return true;
      }
      const prefix = `${connectionId}:`;
      const scoped = [...reconnectFns.entries()].filter(([key, fns]) => key.startsWith(prefix) && fns.size > 0);
      for (const [, fns] of scoped) {
        for (const reconnect of fns) reconnect();
      }
      return scoped.length > 0;
    },
    unregisterReconnect(connectionId, fn) {
      const existing = reconnectFns.get(connectionId);
      if (!existing) return;
      existing.delete(fn);
      if (existing.size === 0) reconnectFns.delete(connectionId);
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
