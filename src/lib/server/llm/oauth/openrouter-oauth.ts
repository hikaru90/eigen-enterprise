import { createHash, randomBytes } from 'node:crypto'

/**
 * OpenRouter "Sign in" (PKCE) — ported from pi (packages/ai/src/auth/oauth/openrouter.ts).
 * OpenRouter exchanges the authorization code for a PERMANENT, user-controlled API key,
 * so afterwards this behaves exactly like the api-key path. The callback_url is
 * caller-controlled — for the web app it points at our own origin.
 */

const AUTHORIZE_URL = 'https://openrouter.ai/auth'
const TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys'

export type PkcePair = { verifier: string; challenge: string }

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function createOpenRouterAuthorizeUrl(callbackUrl: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('callback_url', callbackUrl)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export async function exchangeOpenRouterCode(
  code: string,
  verifier: string,
): Promise<{ apiKey: string }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json().catch(() => null)) as { key?: unknown; error?: unknown } | null
  if (!res.ok) {
    const detail =
      typeof body?.error === 'string' ? `: ${body.error}` : `HTTP ${res.status}`
    throw new Error(`OpenRouter sign-in key exchange failed (${detail}).`)
  }
  if (typeof body?.key !== 'string' || !body.key) {
    throw new Error('OpenRouter sign-in returned no API key.')
  }
  return { apiKey: body.key }
}
