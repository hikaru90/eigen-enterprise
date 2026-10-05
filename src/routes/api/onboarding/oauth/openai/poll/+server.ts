import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import {
  codexBaseUrl,
  exchangeCodexAuthorizationCode,
  pollCodexDeviceAuthOnce,
} from '$lib/server/llm/oauth/openai-codex'
import { saveProviderConfig } from '$lib/server/llm/save-provider-config'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'

type Body = {
  deviceAuthId?: unknown
  userCode?: unknown
  /** Explicitly selected in the wizard — never an implicit default model. */
  modelChat?: unknown
}

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
  const modelChat = typeof body?.modelChat === 'string' ? body.modelChat.trim() : ''
  if (!deviceAuthId || !userCode) {
    return json({ error: 'Missing device code — restart the sign-in.' }, { status: 400 })
  }
  if (!modelChat) {
    return json({ error: 'Pick a chat model to continue.' }, { status: 400 })
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
      modelChat,
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
