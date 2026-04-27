export function nowIso(): string {
  return new Date().toISOString();
}

export function tsToIso(ts: number): string {
  return new Date(ts).toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function deadline(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ac = new AbortController();
  const handle = setTimeout(() => ac.abort(new Error(`timeout after ${ms}ms`)), ms);
  return {
    signal: ac.signal,
    cancel: () => clearTimeout(handle),
  };
}

export function fmtRelative(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, now - then);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}
