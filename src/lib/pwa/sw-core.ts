/**
 * The service worker's decisions, kept free of worker globals so they are
 * unit-tested (src/service-worker.ts only wires them to events).
 */

export type PushPayload = { title: string; body: string; url: string; tag: string; badge?: number }

/**
 * What a push that cannot be read shows. A push must always show a
 * notification (iOS revokes subscriptions that stay silent), so a broken
 * payload is shown as broken rather than dropped or dressed up.
 */
export const UNREADABLE_PUSH: PushPayload = {
  title: 'eigenEnterprise',
  body: 'A notification arrived that could not be read. Open the app to see what is new.',
  url: '/',
  tag: 'push-unreadable',
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/** The server's payload (src/lib/server/push/send.ts), validated; anything else is UNREADABLE_PUSH. */
export function parsePushPayload(data: { text(): string } | null): PushPayload {
  if (!data) return UNREADABLE_PUSH
  let json: unknown
  try {
    json = JSON.parse(data.text())
  } catch {
    return UNREADABLE_PUSH
  }
  if (!json || typeof json !== 'object') return UNREADABLE_PUSH
  const p = json as Record<string, unknown>
  if (!nonEmpty(p.title) || !nonEmpty(p.body) || !nonEmpty(p.url) || !nonEmpty(p.tag)) return UNREADABLE_PUSH
  if (p.badge !== undefined && !(Number.isInteger(p.badge) && (p.badge as number) >= 0)) return UNREADABLE_PUSH
  const out: PushPayload = { title: p.title, body: p.body, url: p.url, tag: p.tag }
  if (p.badge !== undefined) out.badge = p.badge as number
  return out
}

/**
 * One notification per conversation: a newer message replaces the older one
 * (same tag) and alerts again. The icon is the company's (src/routes/app-icon).
 */
export function notificationFor(p: PushPayload): { title: string; options: NotificationOptions & { renotify: boolean } } {
  return {
    title: p.title,
    options: {
      body: p.body,
      tag: p.tag,
      renotify: true,
      data: { url: p.url },
      icon: '/app-icon/any-192.png',
      badge: '/notification-badge.png',
    },
  }
}

/** Where a tapped notification opens — always inside the app's own origin. */
export function notificationTarget(data: unknown, origin: string): { href: string; path: string } {
  const raw = data && typeof data === 'object' && nonEmpty((data as { url?: unknown }).url) ? (data as { url: string }).url : '/'
  let target = new URL(raw, origin)
  if (target.origin !== origin) target = new URL('/', origin)
  return { href: target.href, path: `${target.pathname}${target.search}${target.hash}` }
}

export type FetchStrategy = 'cache' | 'network-or-offline' | 'passthrough'

/**
 * Only the hashed app shell is served from cache (instant launch); page loads
 * go to the network and show OFFLINE_HTML when it is unreachable; data, the
 * live stream and everything else is never touched — no stale messages.
 */
export function fetchStrategy(
  req: { url: string; mode: RequestMode; method: string },
  origin: string,
  shell: ReadonlySet<string>,
): FetchStrategy {
  if (req.method !== 'GET') return 'passthrough'
  const url = new URL(req.url)
  if (url.origin !== origin) return 'passthrough'
  if (req.mode === 'navigate') return 'network-or-offline'
  if (shell.has(url.pathname)) return 'cache'
  return 'passthrough'
}

/** Shown instead of the browser's error page when the installed app opens without a connection. */
export const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Offline</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; font-family: system-ui, sans-serif;
    background: #e8ede5; color: #141c16; text-align: center; padding: 1.5rem; box-sizing: border-box; }
  @media (prefers-color-scheme: dark) { body { background: #141c16; color: #e8ede5; } }
  button { font: inherit; padding: 0.6rem 1.2rem; border-radius: 0.5rem; border: 1px solid currentColor;
    background: transparent; color: inherit; }
</style></head>
<body><main><h1 style="font-size:1.25rem">You're offline</h1>
<p>eigenEnterprise needs a connection to load. Messages sent to you will be here when you're back.</p>
<button type="button" onclick="location.reload()">Try again</button></main></body></html>`
