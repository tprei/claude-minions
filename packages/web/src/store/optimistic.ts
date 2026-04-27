// T31/T33 cover full SSE-reconcile contract; this is the minimum optimistic layer.
// TODO(T33): when a web test runner lands, cover timeout firing, cancel-before-timeout,
// duplicate cancel, and dagStore wiring.
import { randomId } from "../util/randomId.js";

export interface Intent {
  requestId: string;
  appliedAt: number;
  rollback: () => void;
}

interface Entry {
  intent: Intent;
  timer: ReturnType<typeof setTimeout>;
}

const intents = new Map<string, Entry>();

export interface IntentHandle {
  requestId: string;
  cancel: () => void;
}

export function registerIntent(rollback: () => void, timeoutMs = 5000): IntentHandle {
  const requestId = randomId();
  const timer = setTimeout(() => {
    intents.delete(requestId);
    rollback();
  }, timeoutMs);
  intents.set(requestId, {
    intent: { requestId, appliedAt: Date.now(), rollback },
    timer,
  });
  return {
    requestId,
    cancel() {
      const entry = intents.get(requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      intents.delete(requestId);
    },
  };
}

export function getIntent(requestId: string): Intent | undefined {
  return intents.get(requestId)?.intent;
}

export function clear(): void {
  for (const { timer } of intents.values()) clearTimeout(timer);
  intents.clear();
}
