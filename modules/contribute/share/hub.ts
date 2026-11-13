import type { InstallKey } from './identity'
import { signHubRequest } from './contract'

/**
 * Talking to the central board. The hub's origin is CONTRIBUTE_HUB_URL —
 * explicit configuration written by the installer, no default in code: unset
 * means "central board not configured" and nothing is sent.
 */

export type HubRequest = { method: 'POST' | 'PUT' | 'DELETE'; path: string; body: string; headers: Record<string, string> }
export type HubResponse = { status: number; text: string }
/** Throws on a network failure (no answer). */
export type HubTransport = (req: HubRequest) => Promise<HubResponse>

export type HubConfig = { ok: true; url: string } | { ok: false; reason: 'not_configured' | 'invalid'; message: string }

export const HUB_NOT_CONFIGURED = 'The central board is not configured on this server (CONTRIBUTE_HUB_URL is not set), so nothing is shared.'

export function hubConfig(value: string | undefined): HubConfig {
  const raw = value?.trim()
  if (!raw) return { ok: false, reason: 'not_configured', message: HUB_NOT_CONFIGURED }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid', message: `CONTRIBUTE_HUB_URL is not a URL: ${JSON.stringify(raw)}` }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: 'invalid', message: `CONTRIBUTE_HUB_URL must be http(s), got ${u.protocol}` }
  }
  return { ok: true, url: u.origin }
}

export const HUB_TIMEOUT_MS = 15_000

export function fetchHubTransport(origin: string, fetchFn: typeof fetch = fetch): HubTransport {
  return async (req) => {
    const res = await fetchFn(`${origin}${req.path}`, {
      method: req.method,
      headers: { ...req.headers, ...(req.body ? { 'content-type': 'application/json' } : {}) },
      body: req.body || undefined,
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      redirect: 'error',
    })
    return { status: res.status, text: await res.text().catch(() => '') }
  }
}

/** A request signed with the install's key. */
export function signedRequest(key: InstallKey, method: HubRequest['method'], path: string, body: string, now: Date): HubRequest {
  return { method, path, body, headers: signHubRequest({ method, path, body, installId: key.installId, privateKey: key.privateKey, now: now.getTime() }) }
}

/**
 * The hub's answers (from the hub workstream): 200/201 ok · 401 bad
 * signature, unknown install or replay · 403 revoked · 409 (register only)
 * this install id is registered with another key · 429 rate limit · 400
 * schema.
 *
 * ok: done · retry: network, 5xx, 429 (backoff) · unauthorized: 401 (register
 * again, then retry) · revoked: 403 (the hub refused this install) ·
 * refused: any other answer (no retry).
 */
export type HubOutcome = 'ok' | 'retry' | 'unauthorized' | 'revoked' | 'refused'

export function classifyHub(status: number): HubOutcome {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'revoked'
  if (status === 429 || status >= 500) return 'retry'
  return 'refused'
}

/** "the central board answered HTTP 400: …" — the hub's own words, bounded. */
export function hubError(res: HubResponse): string {
  const detail = res.text.trim().slice(0, 300)
  return `The central board answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`
}

export function networkError(err: unknown): string {
  return `The central board could not be reached: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400)
}
