// Browser edition, app origin: keep the app usable offline.
// - /assets/* are content-hashed: cache first.
// - everything else (index.html, config.json, data/*): network first, falling back to the cache;
//   navigations fall back to the cached index.html (single-page app).
// The build replaces the two placeholders below.
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const CACHE = `leegen-app-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("leegen-app-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
  return res;
}

async function networkFirst(request, fallbackUrl) {
  try {
    const res = await fetch(request);
    if (res.ok && request.method === "GET") (await caches.open(CACHE)).put(fallbackUrl ?? request, res.clone());
    return res;
  } catch (e) {
    const hit = await caches.match(fallbackUrl ?? request);
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(event.request));
  } else if (event.request.mode === "navigate") {
    event.respondWith(networkFirst(event.request, "/index.html"));
  } else {
    event.respondWith(networkFirst(event.request));
  }
});
