import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { getSafeErrorMessage } from '$lib/server/auth-form-errors'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'
import { parseProviderInput } from '$lib/server/onboarding/provider-input'
import { saveProviderConfig } from '$lib/server/llm/save-provider-config'

/**
 * Saves the wizard's provider credentials (same persistence path as Settings → LLM) and
 * marks first-run onboarding complete. Fails loud on validation/persistence errors —
 * the gateway test itself runs separately via /api/onboarding/test-provider.
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

  const body = await event.request.json().catch(() => null)
  const parsed = parseProviderInput(body)
  if ('error' in parsed) {
    return json({ error: parsed.error }, { status: 400 })
  }

  const userId = event.locals.user.id
  try {
    await saveProviderConfig({
      userId,
      provider: parsed.config.provider,
      baseUrl: parsed.config.baseUrl,
      apiKey: parsed.config.apiKey,
      ruleChat: parsed.config.ruleChat,
      ruleEmbedding: parsed.config.ruleEmbedding,
      modelChat: parsed.config.modelChat,
      modelEmbedding: parsed.config.modelEmbedding,
      setActive: true,
    })
    await authDb.update(user).set({ onboardingCompleted: true }).where(eq(user.id, userId))
  } catch (error) {
    return json({ error: getSafeErrorMessage(error, 'Unable to save provider configuration.') }, {
      status: 400,
    })
  }

  return json({ ok: true })
}
