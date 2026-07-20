const BUILD_ID = "__TERMES_BUILD_ID__";
const CACHE_PREFIX = "termes-pwa-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const ACTIVATED_MESSAGE = "TERMES_SW_ACTIVATED";
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/termes-favicon-32.png",
  "/termes-icon-launcher-v3-192.png",
  "/termes-icon-launcher-v3-512.png",
  "/termes-icon-maskable-v3-192.png",
  "/termes-icon-maskable-v3-512.png",
  "/termes-apple-touch-icon-v3.png"
];

function isRuntimeRequest(url) {
  return url.pathname.startsWith("/api/") || url.pathname.startsWith("/events/");
}

async function cacheShell() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.allSettled(
    APP_SHELL.map(async (path) => {
      const response = await fetch(path, { cache: "no-store" });
      if (response.ok) await cache.put(path, response.clone());
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();

      const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windowClients) {
        client.postMessage({ type: ACTIVATED_MESSAGE, buildId: BUILD_ID });
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isRuntimeRequest(url) || url.pathname === "/sw.js") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put("/", response.clone());
          }
          return response;
        })
        .catch(async () => (await caches.match("/")) || Response.error())
    );
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/termes-icon-") || url.pathname === "/termes-apple-touch-icon.png") {
    event.respondWith(
      caches.match(request).then(async (cached) => {
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      })
    );
  }
});
