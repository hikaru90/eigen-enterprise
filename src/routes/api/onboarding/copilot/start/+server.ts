import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { startCopilotDeviceFlow } from '$lib/server/llm/oauth/github-copilot'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'

/** Starts the GitHub Copilot subscription device flow for the onboarding wizard. */
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
    const flow = await startCopilotDeviceFlow()
    return json(flow)
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : 'Could not start the GitHub sign-in.' },
      { status: 502 },
    )
  }
}
