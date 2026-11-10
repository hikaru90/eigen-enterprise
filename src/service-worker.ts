/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />
import { build, files, version } from '$service-worker'
import { fetchStrategy, notificationFor, notificationTarget, OFFLINE_HTML, parsePushPayload } from '$lib/pwa/sw-core'

/**
 * The installed app's worker (registered by src/lib/pwa/register.ts):
 * web push (messages → notification + app-icon badge), opening the right
 * conversation when a notification is tapped, and the hashed app shell in
 * cache so the app launches instantly. Data is never cached — see
 * src/lib/pwa/sw-core.ts for every decision made here.
 */

const sw = self as unknown as ServiceWorkerGlobalScope

const CACHE = `ee-shell-${version}`
const ICONS = ['/pwa-192.png', '/pwa-512.png', '/notification-badge.png']
const SHELL = new Set([...build, ...files.filter((f) => ICONS.includes(f))])

// Only the icons up front; the hashed app files (several MB across all pages)
// are cached the first time each is used, so a release costs a phone nothing
// extra — the pages someone actually opens launch from cache.
sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await cache.addAll(ICONS.filter((f) => SHELL.has(f)))
      await sw.skipWaiting()
    })(),
  )
})

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      await sw.clients.claim()
    })(),
  )
})

sw.addEventListener('message', (event) => {
  const data = event.data as { type?: unknown } | null
  if (data && data.type === 'SKIP_WAITING') void sw.skipWaiting()
})

sw.addEventListener('fetch', (event) => {
  const strategy = fetchStrategy(event.request, sw.location.origin, SHELL)
  if (strategy === 'passthrough') return
  if (strategy === 'cache') {
    event.respondWith(cacheFirst(event.request))
    return
  }
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE_HTML, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    ),
  )
})

type BadgeCapable = { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> }

async function setBadge(count: number): Promise<void> {
  const nav = sw.navigator as unknown as BadgeCapable
  if (!nav.setAppBadge || !nav.clearAppBadge) return
  try {
    await (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge())
  } catch (err) {
    console.error('[sw] app badge update failed', err)
  }
}

sw.addEventListener('push', (event) => {
  const payload = parsePushPayload(event.data)
  const { title, options } = notificationFor(payload)
  event.waitUntil(
    Promise.all([
      sw.registration.showNotification(title, options),
      payload.badge !== undefined ? setBadge(payload.badge) : Promise.resolve(),
    ]),
  )
})

/** Focus an open window of the app and take it there; otherwise open one. */
async function openTarget(target: { href: string; path: string }): Promise<void> {
  const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const open = windows.find((w) => w.url.startsWith(sw.location.origin))
  if (!open) {
    await sw.clients.openWindow(target.href)
    return
  }
  await open.focus()
  try {
    await open.navigate(target.href)
  } catch {
    // Safari cannot navigate an uncontrolled window from the worker: the page
    // navigates itself (src/lib/push/navigation-from-sw.ts).
    open.postMessage({ type: 'PUSH_NAVIGATE', url: target.path })
  }
}

sw.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(openTarget(notificationTarget(event.notification.data, sw.location.origin)))
})
