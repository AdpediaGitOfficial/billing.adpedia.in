/* Adpedia Finance — service worker.
 *
 * 🔴 WHAT THIS DELIBERATELY DOES NOT CACHE
 *
 * No page HTML, no API response, no report, no balance. Every one of those is
 * account-scoped financial data, and a cache is shared across whoever uses the device.
 * Serving a cached /dashboard would show one user another's figures after a logout, and
 * serving a cached balance would present a stale number as current — in a ledger that is
 * worse than an error page, because it looks right.
 *
 * So the cache holds exactly two things: the static build output, which is identical for
 * everyone, and an offline fallback page that states plainly that it is offline. The
 * expense queue in IndexedDB is what actually makes the app useful without a network;
 * this file just stops the shell from failing to load.
 */

const VERSION = 'v1'
const SHELL = `adpedia-shell-${VERSION}`
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll([OFFLINE_URL, '/manifest.webmanifest'])).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

function isImmutableAsset(url) {
  // Next.js content-hashes these, so a cached copy can never be the wrong version
  return url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/brand/')
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(SHELL).then((c) => c.put(request, copy))
        }
        return res
      })),
    )
    return
  }

  // Navigations: always go to the network. If it fails, say so — never serve a stale page.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)))
  }

  // Everything else (API calls included) falls through to the network untouched.
})

/* ── Push ─────────────────────────────────────────────────────────────────────── */

self.addEventListener('push', (event) => {
  if (!event.data) return
  let payload
  try { payload = event.data.json() } catch { payload = { title: 'Adpedia Finance', body: event.data.text() } }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'Adpedia Finance', {
      body: payload.body ?? '',
      icon: '/brand/adpedia-logo.svg',
      badge: '/brand/adpedia-logo.svg',
      tag: payload.tag,
      data: { url: payload.url ?? '/dashboard' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url ?? '/dashboard'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(target) && 'focus' in client) return client.focus()
      }
      return self.clients.openWindow(target)
    }),
  )
})

/* ── Background sync: drain the expense queue when the network returns ────────── */

self.addEventListener('sync', (event) => {
  if (event.tag !== 'expense-queue') return
  event.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true })
      .then((list) => list.forEach((c) => c.postMessage({ type: 'drain-expense-queue' }))),
  )
})
