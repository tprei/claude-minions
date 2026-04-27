import { useState, useEffect } from "react";

let isOnline = true;
const listeners = new Set<(online: boolean) => void>();

function setOnline(value: boolean): void {
  if (isOnline === value) return;
  isOnline = value;
  listeners.forEach(l => l(isOnline));
}

export function initOfflineDetection(): void {
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
  setOnline(navigator.onLine);
}

export function subscribeOnline(cb: (online: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useOnline(): boolean {
  const [online, setOnlineState] = useState<boolean>(() => {
    if (typeof navigator !== "undefined") return navigator.onLine;
    return true;
  });

  useEffect(() => {
    function handleOnline() { setOnlineState(true); }
    function handleOffline() { setOnlineState(false); }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return online;
}
