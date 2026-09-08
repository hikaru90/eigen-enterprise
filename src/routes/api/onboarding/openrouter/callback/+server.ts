import type { RequestHandler } from './$types'
import { redirect } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { getSafeErrorMessage } from '$lib/server/auth-form-errors'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'
import { exchangeOpenRouterCode } from '$lib/server/llm/oauth/openrouter-oauth'
import { saveProviderConfig } from '$lib/server/llm/save-provider-config'

const PKCE_COOKIE = 'onboarding_or_pkce'
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
/** Models chosen conservatively so a signed-in OpenRouter account works out of the box. */
const DEFAULT_OPENROUTER_CHAT_MODEL = 'openai/gpt-4o-mini'
const DEFAULT_OPENROUTER_EMBEDDING_MODEL = 'openai/text-embedding-3-small'

/**
 * OpenRouter redirects here with ?code= after the user signs in. The PKCE verifier
 * lives in a short-lived httpOnly cookie set by the authorize endpoint. Exchanges the
 * code for a permanent API key, saves it, completes onboarding, back to the workspace.
 */
export const GET: RequestHandler = async (event) => {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }
  if (!isByokUiEnabled()) {
    throw redirect(302, '/')
  }

  const fail = (message: string): never => redirect(302, `/?openrouter_error=${encodeURIComponent(message)}`)

  const verifier = event.cookies.get(PKCE_COOKIE)
  if (!verifier) {
    fail('OpenRouter sign-in expired — try again.')
  }
  const code = event.url.searchParams.get('code')
  if (!code) {
    const oauthError = event.url.searchParams.get('error_description') ?? event.url.searchParams.get('error')
    fail(`OpenRouter sign-in was denied${oauthError ? `: ${oauthError}` : '.'}`)
  }

  try {
    const { apiKey } = await exchangeOpenRouterCode(code!, verifier!)
    await saveProviderConfig({
      userId: event.locals.user.id,
      provider: 'openrouter',
      baseUrl: DEFAULT_OPENROUTER_BASE_URL,
      apiKey,
      modelChat: DEFAULT_OPENROUTER_CHAT_MODEL,
      modelEmbedding: DEFAULT_OPENROUTER_EMBEDDING_MODEL,
      setActive: true,
    })
    await authDb
      .update(user)
      .set({ onboardingCompleted: true })
      .where(eq(user.id, event.locals.user.id))
  } catch (err) {
    fail(getSafeErrorMessage(err, 'OpenRouter sign-in failed — try again.'))
  }

  event.cookies.delete(PKCE_COOKIE, { path: '/api/onboarding/openrouter' })
  throw redirect(302, '/')
}
