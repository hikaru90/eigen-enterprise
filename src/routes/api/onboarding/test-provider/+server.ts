import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'
import { parseProviderInput } from '$lib/server/onboarding/provider-input'
import { testLlmProviderConnection } from '$lib/server/llm/provider-test'

/**
 * Dry-run provider credential test for the first-run wizard: validates the guided
 * credential shape and performs one real 1-token gateway completion. Never persists.
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
  const parsed = await parseProviderInput(body)
  if ('error' in parsed) {
    return json({ error: parsed.error }, { status: 400 })
  }

  const result = await testLlmProviderConnection(event.locals.user.id, parsed.config)
  return json(result)
}
