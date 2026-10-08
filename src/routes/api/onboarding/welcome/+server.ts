import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { bootApp } from '$lib/server/boot'
import { openWebsiteFoundingJourney } from '$lib/server/onboarding/founding'
import { completeWelcomeOnboarding } from '$lib/server/onboarding/welcome'

/**
 * Marks the welcome boot sequence done (completed or skipped) and — the
 * phase-2e handoff — opens the website-founding journey EMPTY. The chat then
 * drives it: the agent asks the company questions one at a time, captures the
 * answers, and the artifacts (pages, brand doc, approval-gated publishes)
 * execute visibly through the kernel registry. No body, no options — finishing
 * or skipping the boot mean the same thing to the product: never nag again.
 */
export const POST: RequestHandler = async (event) => {
  if (!event.locals.user) {
    return json({ error: 'You must be signed in.' }, { status: 401 })
  }

  await completeWelcomeOnboarding(event.locals.user.id)

  // The founding conversation IS the setup: onboarding opens the journey, the
  // chat drives it. Fails loud — a silently unopened journey would make the
  // agent promise work it never starts.
  const boot = await bootApp()
  await openWebsiteFoundingJourney({
    journeys: boot.journeys,
    sessionId: `onboarding:${event.locals.user.id}`,
  })

  return json({ ok: true })
}
