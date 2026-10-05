import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { startCodexDeviceAuth } from '$lib/server/llm/oauth/openai-codex'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'

/** ChatGPT (Plus/Pro) sign-in, step 1: starts the Codex device-code flow. */
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

  try {
    const device = await startCodexDeviceAuth()
    return json(device)
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : 'Could not start the ChatGPT sign-in.' },
      { status: 502 },
    )
  }
}
