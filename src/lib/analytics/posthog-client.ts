import posthog from 'posthog-js'
import { browser } from '$app/environment'
import { PUBLIC_POSTHOG_HOST, PUBLIC_POSTHOG_KEY } from '$env/static/public'
import { isNoiseException } from '$lib/analytics/exception-noise'

const DEFAULT_EU_API_HOST = 'https://eu.i.posthog.com'
const DEFAULT_EU_UI_HOST = 'https://eu.posthog.com'

let initialized = false

/**
 * PostHog's own events a private surface still sends: page and identity bookkeeping and error
 * tracking. Everything else PostHog reads off the page — autocapture with element text, rage and
 * dead clicks, copied text, heatmaps, session-replay snapshots — is dropped while one is open.
 * Named product events (`capture('thought_deleted', …)`) never start with `$` and carry ids only.
 */
const PRIVATE_SURFACE_POSTHOG_EVENTS = new Set([
  '$pageview',
  '$pageleave',
  '$exception',
  '$identify',
  '$create_alias',
  '$set',
  '$groupidentify',
  '$feature_flag_called',
  '$opt_in',
])

/** How many private surfaces (Memory) are open — explicit, set by the surface itself. */
let openPrivateSurfaces = 0

/**
 * Marks a surface that shows a person's private text (Memory): while it is open, PostHog gets no
 * event built from the page's content. Returns the function that closes it (idempotent).
 */
export function enterPrivateAnalyticsSurface(): () => void {
  openPrivateSurfaces += 1
  let open = true
  return () => {
    if (!open) return
    open = false
    openPrivateSurfaces -= 1
  }
}

function readsThePage(event: string): boolean {
  return event.startsWith('$') && !PRIVATE_SURFACE_POSTHOG_EVENTS.has(event)
}

function posthogKey(): string | undefined {
  const key = PUBLIC_POSTHOG_KEY?.trim()
  return key || undefined
}

function posthogApiHost(): string {
  const host = PUBLIC_POSTHOG_HOST?.trim()
  return host || DEFAULT_EU_API_HOST
}

function posthogUiHost(): string {
  const apiHost = posthogApiHost()
  if (apiHost.includes('eu.')) return DEFAULT_EU_UI_HOST
  return 'https://us.posthog.com'
}

function ensureInit(): boolean {
  if (!browser) return false
  if (initialized) return true
  const key = posthogKey()
  if (!key) return false
  posthog.init(key, {
    api_host: '/ingest',
    ui_host: posthogUiHost(),
    defaults: '2026-01-30',
    person_profiles: 'identified_only',
    capture_pageview: false,
    capture_exceptions: true,
    before_send: (event) => {
      if (event && openPrivateSurfaces > 0 && readsThePage(event.event)) return null
      if (event?.event !== '$exception') return event
      const values = event.properties?.$exception_list
      if (!Array.isArray(values) || values.length === 0) return event
      const allNoise = values.every((item) => {
        if (!item || typeof item !== 'object') return false
        const row = item as { type?: unknown; value?: unknown }
        const synthetic = new Error(typeof row.value === 'string' ? row.value : '')
        if (typeof row.type === 'string' && row.type.trim()) {
          synthetic.name = row.type
        }
        return isNoiseException(synthetic)
      })
      return allNoise ? null : event
    },
  })
  initialized = true
  return true
}

export function isPostHogEnabled(): boolean {
  return browser && Boolean(posthogKey())
}

export function initPostHog(): boolean {
  return ensureInit()
}

export function capture(event: string, properties?: Record<string, unknown>): void {
  if (!ensureInit()) return
  posthog.capture(event, properties)
}

export function identify(userId: string, traits?: Record<string, unknown>): void {
  if (!ensureInit()) return
  posthog.identify(userId, traits)
}

export function resetPostHog(): void {
  if (!browser || !initialized) return
  posthog.reset()
}

export function capturePageview(path: string): void {
  if (!ensureInit()) return
  posthog.capture('$pageview', { $current_url: path })
}

export function captureClientException(error: unknown, properties?: Record<string, unknown>): void {
  if (isNoiseException(error)) return
  if (!ensureInit()) return
  posthog.captureException(error, properties)
}
