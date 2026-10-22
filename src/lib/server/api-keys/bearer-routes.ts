/**
 * Where an API key may authenticate a request — and nowhere else.
 *
 * A key resolves to its owner's user id (hooks.server.ts), and almost every
 * route and page only checks `locals.user`. Without this allowlist any key,
 * including one that may only send mail, is the owner everywhere: thoughts
 * export, chat, approvals, the admin pages. So keys are denied by default and
 * only the routes built for them opt in here.
 *
 * `/api/keys` is deliberately absent: a key must never list, create or revoke
 * keys (creating a fresh key would be an escalation to MCP). Key management is
 * for the signed-in owner only.
 */
export const API_KEY_ROUTES = ['/api/mcp', '/api/mail/send'] as const

/** `pathname` is `url.pathname`, never a full URL. Exact match or a sub-path. */
export function isApiKeyRoute(pathname: string): boolean {
  return API_KEY_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))
}

const BEARER_API_KEY = /^Bearer\s+(eigen_[0-9a-f]+)$/i

/** The `eigen_…` key in an Authorization header, or null when there is none. */
export function parseBearerApiKey(authorization: string | null): string | null {
  const match = (authorization ?? '').match(BEARER_API_KEY)
  return match ? match[1] : null
}
