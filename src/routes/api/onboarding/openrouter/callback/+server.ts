import type { RequestHandler } from './$types'
import { redirect } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { getSafeErrorMessage } from '$lib/server/auth-form-errors'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { exchangeOpenRouterCode } from '$lib/server/llm/oauth/openrouter-oauth'
import { saveProviderConfig } from '$lib/server/llm/save-provider-config'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'

const PKCE_COOKIE = 'onboarding_or_pkce'
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

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

  const fail = (message: string): never =>
    redirect(302, `/?openrouter_error=${encodeURIComponent(message)}`)

  let verifier = ''
  let modelChat = ''
  let modelEmbedding = ''
  try {
    const stored = JSON.parse(event.cookies.get(PKCE_COOKIE) ?? '') as {
      verifier?: unknown
      modelChat?: unknown
      modelEmbedding?: unknown
    }
    if (typeof stored.verifier === 'string') verifier = stored.verifier
    if (typeof stored.modelChat === 'string') modelChat = stored.modelChat
    if (typeof stored.modelEmbedding === 'string') modelEmbedding = stored.modelEmbedding
  } catch {
    fail('OpenRouter sign-in expired — try again.')
  }
  if (!verifier) {
    fail('OpenRouter sign-in expired — try again.')
  }
  if (!modelChat) {
    fail('OpenRouter sign-in expired (model choice missing) — try again.')
  }
  const code = event.url.searchParams.get('code')
  if (!code) {
    const oauthError =
      event.url.searchParams.get('error_description') ?? event.url.searchParams.get('error')
    fail(`OpenRouter sign-in was denied${oauthError ? `: ${oauthError}` : '.'}`)
  }

  try {
    const { apiKey } = await exchangeOpenRouterCode(code!, verifier!)
    await saveProviderConfig({
      userId: event.locals.user.id,
      provider: 'openrouter',
      baseUrl: DEFAULT_OPENROUTER_BASE_URL,
      apiKey,
      modelChat,
      modelEmbedding: modelEmbedding || null,
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
  throw redirect(302, '/?provider=connected')
}
