/**
 * Cross-site form-submission protection — SvelteKit's own `csrf.checkOrigin`
 * rule, run as the first `handle` so that exactly the endpoints which other
 * servers call by design can be exempted (svelte.config.js turns the built-in
 * check off; this is the only replacement, no route is unprotected by accident).
 *
 * The rule (SvelteKit respond.js): a POST/PUT/PATCH/DELETE whose Content-Type
 * is a form type (urlencoded, multipart, text/plain) is refused unless its
 * Origin header is the app's own origin.
 *
 * Exempt, each authenticated on its own:
 * - /api/mail/ses-events — Amazon SNS posts text/plain without an Origin; every
 *   message's signature is verified (modules/email/platform/sns-signature.ts).
 * - /api/mail/unsubscribe/<token> — RFC 8058 one-click unsubscribe: mailbox
 *   providers POST "List-Unsubscribe=One-Click" (urlencoded, no Origin); the
 *   unguessable per-contact token is the authorisation, and it can only
 *   unsubscribe.
 * - /api/calls/livekit — the company's livekit-server posts its webhook (no
 *   Origin, no session); the JWT over the body's sha256, signed with the
 *   LiveKit API secret, is verified before anything is read (modules/calls/webhook.ts).
 */
export const CSRF_EXEMPT_PATHS: readonly string[] = ['/api/mail/ses-events', '/api/mail/unsubscribe', '/api/calls/livekit']

const FORM_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', 'application/x-sveltekit-formdata'])
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function isCsrfExempt(pathname: string): boolean {
  return CSRF_EXEMPT_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/** True when SvelteKit's checkOrigin rule would refuse this request (exempt paths excluded). */
export function isForbiddenCrossSiteForm(request: Request, url: URL): boolean {
  if (!UNSAFE.has(request.method)) return false
  const type = (request.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase()
  if (!FORM_TYPES.has(type)) return false
  if (request.headers.get('origin') === url.origin) return false
  return !isCsrfExempt(url.pathname)
}

export function csrfRefusal(request: Request): Response {
  const message = `Cross-site ${request.method} form submissions are forbidden`
  if (request.headers.get('accept') === 'application/json') {
    return new Response(JSON.stringify({ message }), { status: 403, headers: { 'content-type': 'application/json' } })
  }
  return new Response(message, { status: 403 })
}
