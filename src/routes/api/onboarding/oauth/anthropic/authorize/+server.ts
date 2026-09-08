import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { randomBytes } from 'node:crypto'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'
import { createAnthropicAuthorizeUrl } from '$lib/server/llm/oauth/anthropic'

const PKCE_COOKIE = 'onboarding_anthropic_pkce'

/**
 * Anthropic (Claude Pro/Max) sign-in, step 1: creates the PKCE pair (state = verifier)
 * and returns the claude.ai authorize URL. The wizard opens it; the user authorizes
 * and pastes the resulting code / redirect URL back (pi's manual_code pattern).
 */
export const POST: RequestHandler = async (event) => {
  if (!event.locals.user) {
    return json({ error: 'You must be signed in.' }, { status: 401 })
  }
  if (!isByokUiEnabled()) {
    return json(
      { error: 'Bring your own key is not available on this deployment.' },
      { status: 403 },
    )
  }

  const verifier = randomBytes(32).toString('base64url')
  event.cookies.set(PKCE_COOKIE, verifier, {
    path: '/api/onboarding/oauth/anthropic',
    httpOnly: true,
    sameSite: 'lax',
    secure: event.url.protocol === 'https:',
    maxAge: 600,
  })

  return json({ url: createAnthropicAuthorizeUrl(verifier) })
}
