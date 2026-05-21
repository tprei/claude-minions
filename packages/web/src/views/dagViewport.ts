export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

const VIEWPORT_KEY_PREFIX = "dag:viewport:";

function key(connId: string, dagId: string): string {
  return `${VIEWPORT_KEY_PREFIX}${connId}:${dagId}`;
}

function isViewport(value: unknown): value is Viewport {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.x === "number" &&
    typeof v.y === "number" &&
    typeof v.scale === "number" &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.scale)
  );
}

export function getViewport(connId: string, dagId: string): Viewport | null {
  if (typeof globalThis.localStorage === "undefined") return null;
  try {
    const raw = globalThis.localStorage.getItem(key(connId, dagId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isViewport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function setViewport(connId: string, dagId: string, vp: Viewport): void {
  if (typeof globalThis.localStorage === "undefined") return;
  try {
    globalThis.localStorage.setItem(key(connId, dagId), JSON.stringify(vp));
  } catch {
    // storage full or unavailable — drop silently
  }
}

export function clearConnectionViewports(connId: string): void {
  if (typeof globalThis.localStorage === "undefined") return;
  const prefix = `${VIEWPORT_KEY_PREFIX}${connId}:`;
  try {
    const keys: string[] = [];
    for (let index = 0; index < globalThis.localStorage.length; index += 1) {
      const storageKey = globalThis.localStorage.key(index);
      if (storageKey?.startsWith(prefix)) {
        keys.push(storageKey);
      }
    }
    for (const storageKey of keys) {
      globalThis.localStorage.removeItem(storageKey);
    }
  } catch {
    // storage unavailable — drop silently
  }
}
