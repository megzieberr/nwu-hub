// Service worker for the NWU Study Hub — makes the app installable, quick to open, and now
// delivers PUSH REMINDERS (classes ~45 min before; tests/exams the morning of). It caches the app
// shell so the page opens instantly and survives a flaky connection; live data still comes from
// Supabase over the network (cross-origin requests below are left untouched).
const CACHE = 'nwu-hub-v3'

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

// A reminder arrived from the send-push Edge Function. Payload: { title, body, url, tag }.
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch (_) { d = {} }
  const title = d.title || 'NWU Study Hub'
  e.waitUntil(
    self.registration.showNotification(title, {
      body: d.body || '',
      tag: d.tag || 'nwu-hub',
      icon: '/nwu-hub/icon-192.png',
      badge: '/nwu-hub/icon-192.png',
      data: { url: d.url || '/nwu-hub/' },
    })
  )
})

// Tapping a reminder: focus an already-open hub tab (navigating it to the deep-link) or open one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/nwu-hub/'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if (c.url.includes('/nwu-hub/') && 'focus' in c) {
          if ('navigate' in c) c.navigate(url).catch(() => {})
          return c.focus()
        }
      }
      return self.clients.openWindow(url)
    })
  )
})
