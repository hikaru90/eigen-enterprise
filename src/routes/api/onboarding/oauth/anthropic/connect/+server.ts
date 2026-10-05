import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { getSafeErrorMessage } from '$lib/server/auth-form-errors'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import {
  exchangeAnthropicCode,
  parseAuthorizationInput,
} from '$lib/server/llm/oauth/anthropic'
import { anthropicApiBaseUrl } from '$lib/server/llm/oauth/anthropic'
import { saveProviderConfig } from '$lib/server/llm/save-provider-config'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'

const PKCE_COOKIE = 'onboarding_anthropic_pkce'
/**
 * Anthropic (Claude Pro/Max) sign-in, step 2: the user pasted the authorization code
 * (or the full redirect URL). Validates state against the PKCE cookie, exchanges for
 * tokens, saves the subscription credential, completes onboarding.
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

  const verifier = event.cookies.get(PKCE_COOKIE)
  if (!verifier) {
    return json({ error: 'Sign-in expired — start again.' }, { status: 400 })
  }

  const body = (await event.request.json().catch(() => null)) as
    | { code?: unknown; modelChat?: unknown }
    | null
  const rawCode = typeof body?.code === 'string' ? body.code : ''
  const modelChat = typeof body?.modelChat === 'string' ? body.modelChat.trim() : ''
  if (!modelChat) {
    return json({ error: 'Pick a chat model to continue.' }, { status: 400 })
  }
  const parsed = parseAuthorizationInput(rawCode)
  if (!parsed.code) {
    return json({ error: 'Paste the authorization code or the full redirect URL.' }, { status: 400 })
  }
  const state = parsed.state ?? verifier
  if (state !== verifier) {
    return json({ error: 'OAuth state mismatch — start again.' }, { status: 400 })
  }

  try {
    const tokens = await exchangeAnthropicCode({ code: parsed.code, state, verifier })
    await saveProviderConfig({
      userId: event.locals.user.id,
      provider: 'anthropic',
      baseUrl: anthropicApiBaseUrl(),
      apiKey: '',
      modelChat,
      setActive: true,
      oauth: {
        access: tokens.access,
        refresh: tokens.refresh,
        expiresAt: new Date(tokens.expiresAtMs),
        meta: null,
      },
    })
    await authDb
      .update(user)
      .set({ onboardingCompleted: true })
      .where(eq(user.id, event.locals.user.id))
    event.cookies.delete(PKCE_COOKIE, { path: '/api/onboarding/oauth/anthropic' })
    return json({ ok: true })
  } catch (err) {
    return json(
      { error: getSafeErrorMessage(err, 'Anthropic sign-in failed — try again.') },
      { status: 400 },
    )
  }
}
