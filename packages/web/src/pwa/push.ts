import { useState, useEffect } from "react";
import type { Connection } from "../connections/store.js";
import { getVapidPublicKey, listPushSubscriptions, subscribePush, unsubscribePush } from "../transport/rest.js";

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

function matchesApplicationServerKey(subscription: PushSubscription, expected: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey;
  if (current === null) return false;
  const bytes = new Uint8Array(current);
  if (bytes.length !== expected.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== expected[i]) return false;
  }
  return true;
}

async function getBrowserSubscription(): Promise<PushSubscription | null> {
  const serviceWorker = navigator.serviceWorker;
  if (!serviceWorker) return null;
  const reg = await serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function registerPush(conn: Connection, workflowId: string): Promise<boolean> {
  const vapidRes = await getVapidPublicKey(conn);
  if (!vapidRes?.publicKey) return false;

  if (!("Notification" in window)) return false;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  const applicationServerKey = urlBase64ToUint8Array(vapidRes.publicKey);
  const reg = await navigator.serviceWorker.ready;
  let subscription = await reg.pushManager.getSubscription();
  if (subscription && !matchesApplicationServerKey(subscription, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
  });

  const json = subscription.toJSON();
  const keys = json.keys as { p256dh: string; auth: string } | undefined;
  if (!json.endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error("Incomplete push subscription");
  }

  await subscribePush(conn, {
    workflowId,
    subscription: {
      endpoint: json.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    },
  });

  return true;
}

export async function isPushRegisteredForWorkflow(conn: Connection, workflowId: string): Promise<boolean> {
  const subscription = await getBrowserSubscription();
  if (!subscription) return false;

  const { subscriptions } = await listPushSubscriptions(conn, workflowId);
  return subscriptions.some((candidate) => candidate.endpoint === subscription.endpoint);
}

export async function unregisterPush(conn: Connection, workflowId: string): Promise<void> {
  const subscription = await getBrowserSubscription();
  if (subscription) {
    await unsubscribePush(conn, subscription.endpoint, workflowId);
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
