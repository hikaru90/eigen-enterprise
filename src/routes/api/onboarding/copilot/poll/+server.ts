import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'
import {
  fetchCopilotAccessToken,
  pollCopilotDeviceFlowOnce,
} from '$lib/server/llm/oauth/github-copilot'
import { saveProviderConfig } from '$lib/server/llm/save-provider-config'

type Body = { deviceCode?: unknown }

/**
 * ONE poll attempt for the Copilot device flow. While the user has not authorized,
 * responds {status:'pending'} and the wizard retries on its own cadence. Once
 * authorized: exchanges for the Copilot token (the real connection proof), saves the
 * OAuth credential, and completes onboarding.
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

  const body = (await event.request.json().catch(() => null)) as Body | null
  const deviceCode = typeof body?.deviceCode === 'string' ? body.deviceCode : ''
  if (!deviceCode) {
    return json({ error: 'Missing device code — restart the sign-in.' }, { status: 400 })
  }

  let poll: Awaited<ReturnType<typeof pollCopilotDeviceFlowOnce>>
  try {
    poll = await pollCopilotDeviceFlowOnce(deviceCode)
  } catch (err) {
    return json(
      { status: 'failed', error: err instanceof Error ? err.message : 'GitHub poll failed.' },
      { status: 200 },
    )
  }

  if (poll.status === 'pending') {
    return json({ status: 'pending' })
  }
  if (poll.status === 'failed') {
    return json({ status: 'failed', error: poll.error })
  }

  try {
    const session = await fetchCopilotAccessToken(poll.githubToken)
    await saveProviderConfig({
      userId: event.locals.user.id,
      provider: 'github_copilot',
      baseUrl: session.baseUrl,
      apiKey: '',
      setActive: true,
      oauth: {
        access: session.access,
        refresh: session.refresh,
        expiresAt: new Date(session.expiresAtMs),
        meta: { availableModelIds: session.availableModelIds },
      },
    })
    await authDb
      .update(user)
      .set({ onboardingCompleted: true })
      .where(eq(user.id, event.locals.user.id))
    return json({
      status: 'connected',
      models: session.availableModelIds,
      baseUrl: session.baseUrl,
    })
  } catch (err) {
    return json({
      status: 'failed',
      error: err instanceof Error ? err.message : 'Copilot connection failed.',
    })
  }
}
