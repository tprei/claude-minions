export {};

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
  workflowId?: string;
  taskId?: string;
  code?: string;
  cursor?: number;
}

interface PushData {
  json(): unknown;
  text(): string;
}

interface PushEventLike extends ExtendableEvent {
  data: PushData | null;
}

interface NotificationClickEventLike extends ExtendableEvent {
  notification: Notification;
}

const PRECACHE = "minions-web-precache-v1";
const MANIFEST = self.__WB_MANIFEST;

function manifestUrls(): string[] {
  return MANIFEST.map((entry) => new URL(entry.url, self.location.origin).toString());
}

function readPushPayload(data: PushData | null): PushPayload {
  if (!data) return {};
  try {
    const parsed = data.json();
    return typeof parsed === "object" && parsed !== null ? parsed as PushPayload : {};
  } catch {
    try {
      return { body: data.text() };
    } catch {
      return {};
    }
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PRECACHE)
      .then((cache) => cache.addAll(manifestUrls()))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== PRECACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/index.html").then((res) => res ?? Response.error())),
    );
    return;
  }
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        const copy = res.clone();
        if (res.ok) void caches.open(PRECACHE).then((cache) => cache.put(event.request, copy));
        return res;
      });
    }),
  );
});

self.addEventListener("push", (event) => {
  const pushEvent = event as PushEventLike;
  const payload = readPushPayload(pushEvent.data);
  const title = payload.title ?? "Minions";
  const options: NotificationOptions = {
    body: payload.body,
    tag: payload.tag,
    data: payload,
  };
  pushEvent.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  const clickEvent = event as NotificationClickEventLike;
  const payload = clickEvent.notification.data as PushPayload | undefined;
  const url = payload?.url ?? "/";
  clickEvent.notification.close();
  clickEvent.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
