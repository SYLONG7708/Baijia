const CACHE_NAME = "baijia-monitor-v19-20260711-trend-repair";
const ASSETS = [
  "./",
  "./index.html",
  "./live.html",
  "./logic.html",
  "./simulator.html",
  "./styles.css",
  "./simulator.css",
  "./app.js",
  "./simulator.js",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      const staleKeys = keys.filter((key) => key !== CACHE_NAME);
      const shouldReloadAdvisor = staleKeys.length > 0;
      return Promise.all(staleKeys.map((key) => caches.delete(key)))
        .then(() => self.clients.claim())
        .then(() => (shouldReloadAdvisor ? self.clients.matchAll({ type: "window", includeUncontrolled: true }) : []))
        .then((clients) => Promise.all(clients.map((client) => {
          const url = new URL(client.url);
          if (url.pathname.endsWith("/simulator.html") || url.pathname.endsWith("/index.html") || url.pathname.endsWith("/live.html") || url.pathname === "/") {
            return client.navigate(client.url).catch(() => null);
          }
          return null;
        })));
    })
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
