import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { completeWelcomeOnboarding } from '$lib/server/onboarding/welcome'

/**
 * Marks the welcome setup wizard done (completed or skipped). No body, no options —
 * finishing or skipping the tour mean the same thing to the product: never nag again.
 */
export const POST: RequestHandler = async (event) => {
  if (!event.locals.user) {
    return json({ error: 'You must be signed in.' }, { status: 401 })
  }

  await completeWelcomeOnboarding(event.locals.user.id)

  return json({ ok: true })
}
