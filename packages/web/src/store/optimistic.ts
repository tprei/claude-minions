import { randomId } from "../util/randomId.js";

const PILL_DELAY_MS = 250;
const ROLLBACK_TIMEOUT_MS = 5000;

export interface IntentSpec {
  connId: string;
  description: string;
  rollback: () => void;
}

export interface IntentSnapshot {
  requestId: string;
  connId: string;
  description: string;
  appliedAt: number;
  showPill: boolean;
}

interface IntentEntry {
  snapshot: IntentSnapshot;
  rollback: () => void;
  rollbackTimer: ReturnType<typeof setTimeout>;
  pillTimer: ReturnType<typeof setTimeout>;
  resolved: boolean;
}

export interface IntentHandle {
  requestId: string;
  connId: string;
  cancel: () => void;
}

export interface ToastInfo {
  id: string;
  kind: "rollback";
  description: string;
  message?: string;
  createdAt: number;
}

const entries = new Map<string, IntentEntry>();
const intentListeners = new Set<(snap: ReadonlyArray<IntentSnapshot>) => void>();
const toasts: ToastInfo[] = [];
const toastListeners = new Set<(t: ReadonlyArray<ToastInfo>) => void>();

let activeConnIdResolver: () => string | null = () => null;

export function setActiveConnIdResolver(fn: () => string | null): void {
  activeConnIdResolver = fn;
}

function snapshot(): ReadonlyArray<IntentSnapshot> {
  return Array.from(entries.values(), (e) => e.snapshot);
}

function notifyIntents(): void {
  const snap = snapshot();
  for (const l of intentListeners) l(snap);
}

function notifyToasts(): void {
  const snap = toasts.slice();
  for (const l of toastListeners) l(snap);
}

export function subscribeIntents(l: (s: ReadonlyArray<IntentSnapshot>) => void): () => void {
  intentListeners.add(l);
  return () => { intentListeners.delete(l); };
}

export function subscribeToasts(l: (t: ReadonlyArray<ToastInfo>) => void): () => void {
  toastListeners.add(l);
  return () => { toastListeners.delete(l); };
}

export function getIntents(): ReadonlyArray<IntentSnapshot> {
  return snapshot();
}

export function getIntentsForConn(connId: string): ReadonlyArray<IntentSnapshot> {
  return snapshot().filter((s) => s.connId === connId);
}

export function getToasts(): ReadonlyArray<ToastInfo> {
  return toasts.slice();
}

export function dismissToast(id: string): void {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx < 0) return;
  toasts.splice(idx, 1);
  notifyToasts();
}

function pushToast(description: string, message?: string): void {
  toasts.push({ id: randomId(), kind: "rollback", description, message, createdAt: Date.now() });
  notifyToasts();
}

interface RegisterOptions {
  timeoutMs?: number;
  pillDelayMs?: number;
}

export function registerIntent(spec: IntentSpec, opts: RegisterOptions = {}): IntentHandle {
  const requestId = randomId();
  const timeoutMs = opts.timeoutMs ?? ROLLBACK_TIMEOUT_MS;
  const pillDelayMs = opts.pillDelayMs ?? PILL_DELAY_MS;

  const entry: IntentEntry = {
    snapshot: {
      requestId,
      connId: spec.connId,
      description: spec.description,
      appliedAt: Date.now(),
      showPill: false,
    },
    rollback: spec.rollback,
    rollbackTimer: undefined as unknown as ReturnType<typeof setTimeout>,
    pillTimer: undefined as unknown as ReturnType<typeof setTimeout>,
    resolved: false,
  };

  entry.rollbackTimer = setTimeout(() => {
    if (entry.resolved) return;
    entry.resolved = true;
    clearTimeout(entry.pillTimer);
    entries.delete(requestId);
    if (activeConnIdResolver() === spec.connId) {
      try { spec.rollback(); } catch { /* swallow */ }
      pushToast(spec.description, "No response from server within 5s — change rolled back.");
    }
    notifyIntents();
  }, timeoutMs);

  entry.pillTimer = setTimeout(() => {
    if (entry.resolved) return;
    entry.snapshot = { ...entry.snapshot, showPill: true };
    notifyIntents();
  }, pillDelayMs);

  entries.set(requestId, entry);
  notifyIntents();

  return {
    requestId,
    connId: spec.connId,
    cancel() {
      if (entry.resolved) return;
      entry.resolved = true;
      clearTimeout(entry.rollbackTimer);
      clearTimeout(entry.pillTimer);
      entries.delete(requestId);
      notifyIntents();
    },
  };
}

export function getIntent(requestId: string): IntentSnapshot | undefined {
  return entries.get(requestId)?.snapshot;
}

export function clear(): void {
  for (const e of entries.values()) {
    clearTimeout(e.rollbackTimer);
    clearTimeout(e.pillTimer);
    e.resolved = true;
  }
  entries.clear();
  toasts.length = 0;
  notifyIntents();
  notifyToasts();
}

export interface DispatchOptions<T> {
  connId: string;
  description: string;
  apply: () => void;
  rollback: () => void;
  /**
   * Subscribe to a store / channel. Invoke `commit()` when the optimistic
   * change is reconciled by an authoritative SSE event. The returned function
   * unsubscribes.
   *
   * When omitted, dispatchCommand cancels the intent on REST success — useful
   * for fire-and-forget actions that don't have a corresponding SSE signal.
   */
  awaitCommit?: (commit: () => void) => () => void;
  request: () => Promise<T>;
  timeoutMs?: number;
  pillDelayMs?: number;
}

export async function dispatchCommand<T>(opts: DispatchOptions<T>): Promise<T> {
  opts.apply();

  let unsub: (() => void) | undefined;
  let finalized = false;

  const finalize = (): boolean => {
    if (finalized) return false;
    finalized = true;
    unsub?.();
    return true;
  };

  const handle = registerIntent(
    {
      connId: opts.connId,
      description: opts.description,
      rollback: () => {
        if (finalize()) opts.rollback();
      },
    },
    { timeoutMs: opts.timeoutMs, pillDelayMs: opts.pillDelayMs },
  );

  if (opts.awaitCommit) {
    unsub = opts.awaitCommit(() => {
      if (finalize()) handle.cancel();
    });
  }

  try {
    const res = await opts.request();
    if (!opts.awaitCommit && finalize()) {
      handle.cancel();
    }
    return res;
  } catch (err) {
    if (finalize()) {
      handle.cancel();
      if (activeConnIdResolver() === opts.connId) {
        opts.rollback();
        pushToast(opts.description, err instanceof Error ? err.message : String(err));
      }
    }
    throw err;
  }
}
