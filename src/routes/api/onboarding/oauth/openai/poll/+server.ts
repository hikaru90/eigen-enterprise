import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'
import {
  codexBaseUrl,
  exchangeCodexAuthorizationCode,
  pollCodexDeviceAuthOnce,
} from '$lib/server/llm/oauth/openai-codex'
import { saveProviderConfig } from '$lib/server/llm/save-provider-config'

const DEFAULT_CODEX_CHAT_MODEL = 'gpt-5.1-codex'

type Body = { deviceAuthId?: unknown; userCode?: unknown }

/**
 * ChatGPT (Plus/Pro) sign-in, step 2: ONE poll attempt. Once the user authorizes, the
 * device authorization_code is exchanged for tokens (the real connection proof), the
 * subscription credential is saved, and onboarding completes.
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
  const deviceAuthId = typeof body?.deviceAuthId === 'string' ? body.deviceAuthId : ''
  const userCode = typeof body?.userCode === 'string' ? body.userCode : ''
  if (!deviceAuthId || !userCode) {
    return json({ error: 'Missing device code — restart the sign-in.' }, { status: 400 })
  }

  let poll: Awaited<ReturnType<typeof pollCodexDeviceAuthOnce>>
  try {
    poll = await pollCodexDeviceAuthOnce({ deviceAuthId, userCode })
  } catch (err) {
    return json(
      { status: 'failed', error: err instanceof Error ? err.message : 'ChatGPT poll failed.' },
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
    const tokens = await exchangeCodexAuthorizationCode({
      authorizationCode: poll.authorizationCode,
      codeVerifier: poll.codeVerifier,
    })
    await saveProviderConfig({
      userId: event.locals.user.id,
      provider: 'openai_codex',
      baseUrl: codexBaseUrl(),
      apiKey: '',
      modelChat: DEFAULT_CODEX_CHAT_MODEL,
      setActive: true,
      oauth: {
        access: tokens.access,
        refresh: tokens.refresh,
        expiresAt: new Date(tokens.expiresAtMs),
        meta: { accountId: tokens.accountId },
      },
    })
    await authDb
      .update(user)
      .set({ onboardingCompleted: true })
      .where(eq(user.id, event.locals.user.id))
    return json({ status: 'connected' })
  } catch (err) {
    return json({
      status: 'failed',
      error: err instanceof Error ? err.message : 'ChatGPT connection failed.',
    })
  }
}
