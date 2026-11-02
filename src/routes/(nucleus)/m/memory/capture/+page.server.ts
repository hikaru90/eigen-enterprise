import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { loadRecentCaptureThoughts } from '$lib/server/capture/load-recent-capture-thoughts'
import { getDb } from '$lib/server/db'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { userPreference } from '$lib/server/db/schema'
import { isGroundingQuestionDue } from '$lib/server/grounding/question-due'
import { ensureUserOntologySeeded } from '$lib/server/ontology-db'

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }
  const userId = event.locals.user.id
  await ensureUserOntologySeeded(getDb(), userId)

  const authUser = await authDb
    .select({ onboardingCompleted: user.onboardingCompleted, accountKind: user.accountKind })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
    .then((rows) => rows[0])

  const isHarness = authUser?.accountKind === 'harness'

  const [pref, groundingQuestionEligible] = await Promise.all([
    getDb()
      .select({ preferredLanguage: userPreference.preferredLanguage })
      .from(userPreference)
      .where(eq(userPreference.userId, userId))
      .limit(1)
      .then((rows) => rows[0]),
    isGroundingQuestionDue(userId), // shared check-in cadence (grounding | relevance)
  ])

  const { recentThoughts, recentThoughtDetails } = await loadRecentCaptureThoughts(userId)

  return {
    user: event.locals.user,
    isHarness,
    onboardingCompleted: isHarness || authUser?.onboardingCompleted === true,
    preferredLanguage: pref?.preferredLanguage ?? 'en',
    groundingQuestionEligible,
    recentThoughts,
    recentThoughtDetails,
  }
}

export const actions: Actions = {
  completeOnboarding: async (event) => {
    if (!event.locals.user) {
      return fail(401, { message: 'Unauthorized' })
    }

    await authDb
      .update(user)
      .set({ onboardingCompleted: true })
      .where(eq(user.id, event.locals.user.id))

    return { ok: true as const }
  },

  skipOnboarding: async (event) => {
    if (!event.locals.user) {
      return fail(401, { message: 'Unauthorized' })
    }

    await authDb
      .update(user)
      .set({ onboardingCompleted: true })
      .where(eq(user.id, event.locals.user.id))

    return { ok: true as const }
  },
}
