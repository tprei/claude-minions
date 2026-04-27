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
