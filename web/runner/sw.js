// Browser edition, runner origin: cache Python so runs work offline and start fast.
// - pyodide-<version>/* is versioned: cache first (precached at install).
// - the runner's own files: network first, falling back to the cache.
// The build replaces the two placeholders below.
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const CACHE = `leegen-runner-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("leegen-runner-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/pyodide-")) {
    event.respondWith((async () => {
      const hit = await caches.match(event.request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok) (await caches.open(CACHE)).put(event.request, res.clone());
      return res;
    })());
    return;
  }
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request);
      if (res.ok) (await caches.open(CACHE)).put(event.request, res.clone());
      return res;
    } catch (e) {
      const hit = await caches.match(event.request, { ignoreSearch: true });
      if (hit) return hit;
      throw e;
    }
  })());
});
