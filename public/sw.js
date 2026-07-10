// Minimal service worker for the NWU Study Hub — makes the app installable and quick to
// open on the phone. No push, no notifications. It caches the app shell so the page opens
// instantly and survives a flaky connection; live data still comes from Supabase over the
// network (cross-origin requests below are left untouched).
const CACHE = 'nwu-hub-v1'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const { request } = e
  // Only handle same-origin GETs. Supabase (cross-origin) + POST/auth pass straight through.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return

  // Navigations: network-first so a fresh deploy shows up, falling back to the cached shell.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => { caches.open(CACHE).then((c) => c.put(request, res.clone())); return res })
        .catch(() => caches.match(request).then((r) => r || caches.match('/nwu-hub/index.html')))
    )
    return
  }

  // Static assets (hashed JS/CSS, icons): stale-while-revalidate.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request)
      const network = fetch(request)
        .then((res) => { if (res && res.ok) cache.put(request, res.clone()); return res })
        .catch(() => cached)
      return cached || network
    })
  )
})
