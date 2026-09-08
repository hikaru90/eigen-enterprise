import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'
import {
  createOpenRouterAuthorizeUrl,
  generatePkce,
} from '$lib/server/llm/oauth/openrouter-oauth'

const PKCE_COOKIE = 'onboarding_or_pkce'

/** Creates the PKCE pair and returns the OpenRouter sign-in URL for the wizard. */
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

  const { verifier, challenge } = generatePkce()
  const callbackUrl = new URL('/api/onboarding/openrouter/callback', event.url.origin).toString()

  event.cookies.set(PKCE_COOKIE, verifier, {
    path: '/api/onboarding/openrouter',
    httpOnly: true,
    sameSite: 'lax',
    secure: event.url.protocol === 'https:',
    maxAge: 600,
  })

  return json({ url: createOpenRouterAuthorizeUrl(callbackUrl, challenge) })
}
