import { useState, useEffect } from "react";
import type { VapidPublicKeyResponse } from "@minions/shared";

interface PushApi {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  del: (path: string, body?: unknown) => Promise<unknown>;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export async function registerPush(api: PushApi): Promise<boolean> {
  const vapidRes = await api.get("/api/push/vapid-public-key") as VapidPublicKeyResponse | null;
  if (!vapidRes?.publicKey) return false;

  if (!("Notification" in window)) return false;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidRes.publicKey).buffer as ArrayBuffer,
  });

  const json = subscription.toJSON();
  const keys = json.keys as { p256dh: string; auth: string } | undefined;
  if (!json.endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error("Incomplete push subscription");
  }

  await api.post("/api/push-subscribe", {
    endpoint: json.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    userAgent: navigator.userAgent,
  });

  return true;
}

export async function unregisterPush(api: PushApi): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();
  if (subscription) {
    await api.del("/api/push-subscribe", { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  }
}

export function usePushPermission(): NotificationPermission | "unsupported" {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
    return Notification.permission;
  });

  useEffect(() => {
    if (!("Notification" in window)) {
      setPermission("unsupported");
      return;
    }
    setPermission(Notification.permission);
  }, []);

  return permission;
}
