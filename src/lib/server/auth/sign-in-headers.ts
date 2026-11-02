import type { RequestEvent } from '@sveltejs/kit'

/**
 * Headers for a server-side Better Auth sign-in, so the new session records
 * the browser's user agent and address (Settings › Passkeys & sessions shows
 * them). Without them every session read "Unknown device · Unknown address".
 * The client address comes from SvelteKit (adapter-resolved) when no proxy
 * already set x-forwarded-for.
 */
export function signInHeaders(event: Pick<RequestEvent, 'request' | 'getClientAddress'>): Headers {
  const headers = new Headers()
  const ua = event.request.headers.get('user-agent')
  if (ua) headers.set('user-agent', ua)
  let forwarded = event.request.headers.get('x-forwarded-for')
  if (!forwarded) {
    try {
      forwarded = event.getClientAddress()
    } catch {
      forwarded = null
    }
  }
  if (forwarded) headers.set('x-forwarded-for', forwarded)
  return headers
}
