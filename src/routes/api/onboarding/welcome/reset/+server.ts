import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { resetWelcomeOnboarding } from '$lib/server/onboarding/welcome'

/**
 * Restarts the welcome setup wizard: clears the completion stamp so the
 * nucleus homepage shows the wizard again on the next load. No body, no
 * options — restarting onboarding means exactly one thing.
 */
export const POST: RequestHandler = async (event) => {
  if (!event.locals.user) {
    return json({ error: 'You must be signed in.' }, { status: 401 })
  }

  await resetWelcomeOnboarding(event.locals.user.id)

  return json({ ok: true })
}
