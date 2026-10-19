import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { completeWelcomeOnboarding } from '$lib/server/onboarding/welcome'

/**
 * Marks the scripted first run done (completed or skipped). From here the
 * onboarding is ASSISTED: the orchestrator agent takes over in the chat
 * (POST /api/chat with `onboardingHandoff`) and opens the website founding
 * journey itself once the owner agrees (modules/orchestrator/onboarding-context.ts).
 * No body, no options — finishing or skipping mean the same thing: never nag again.
 */
export const POST: RequestHandler = async (event) => {
  if (!event.locals.user) {
    return json({ error: 'You must be signed in.' }, { status: 401 })
  }

  await completeWelcomeOnboarding(event.locals.user.id)

  return json({ ok: true })
}
