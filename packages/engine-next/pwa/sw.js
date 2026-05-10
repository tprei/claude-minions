const CACHE = "minions-v2";
const ASSETS = [
  "/",
  "/assets/app-v1.js",
  "/assets/styles-v1.css",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (evt) => {
  evt.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (evt) => {
  evt.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (evt) => {
  const url = new URL(evt.request.url);
  const path = url.pathname;

  if (
    path.startsWith("/workflows") ||
    path.startsWith("/commands") ||
    path.startsWith("/push") ||
    path === "/sw.js"
  ) {
    return;
  }

  if (evt.request.mode === "navigate") {
    evt.respondWith(
      fetch(evt.request).catch(() => caches.match("/"))
    );
    return;
  }

  if (path.startsWith("/assets/") || path.startsWith("/icons/")) {
    evt.respondWith(
      caches.match(evt.request).then((cached) => cached ?? fetch(evt.request))
    );
    return;
  }
});

self.addEventListener("push", (evt) => {
  const p = evt.data?.json() ?? {};
  evt.waitUntil(
    self.registration.showNotification(p.title ?? "Minions", {
      body: p.body ?? "",
      tag: p.tag ?? "minions",
      renotify: true,
      icon: "/icons/icon-192.png",
      data: {
        url: p.url ?? "/",
        workflowId: p.workflowId ?? null,
        taskId: p.taskId ?? null,
      },
    })
  );
});

self.addEventListener("notificationclick", (evt) => {
  evt.notification.close();
  const { workflowId, url } = evt.notification.data ?? {};

  evt.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        const target = clientList.find((c) => c.url.startsWith(self.location.origin));
        if (target) {
          target.postMessage({ type: "navigate", url, workflowId });
          return target.focus();
        }
        return self.clients.openWindow(`/#/workflow/${workflowId}`);
      })
  );
});
