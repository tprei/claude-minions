import { useSyncExternalStore } from "react";
import { registerSW } from "virtual:pwa-register";

interface SwState {
  needRefresh: boolean;
  registrationError: string | null;
  registered: boolean;
}

let state: SwState = {
  needRefresh: false,
  registrationError: null,
  registered: false,
};

const listeners = new Set<() => void>();
let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;
let registered = false;

function setState(next: Partial<SwState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): SwState {
  return state;
}

export function registerServiceWorker(): void {
  if (registered) return;
  registered = true;
  try {
    updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        setState({ needRefresh: true });
      },
      onRegisteredSW() {
        setState({ registered: true, registrationError: null });
      },
      onRegisterError(err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setState({ registrationError: message });
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState({ registrationError: message });
  }
}

export async function applyUpdate(): Promise<void> {
  if (updateSW) {
    await updateSW(true);
    return;
  }
  window.location.reload();
}

export function useSwState(): SwState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
