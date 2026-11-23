import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { BRAIN_KNOWS_LIMIT } from '$lib/memory/brain-knows'
import { loadRecentCaptureThoughts } from '$lib/server/capture/load-recent-capture-thoughts'
import { getDb } from '$lib/server/db'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { isGroundingQuestionDue } from '$lib/server/grounding/question-due'
import { ensureUserOntologySeeded } from '$lib/server/ontology-db'

/**
 * Memory › What the brain knows (plan/concept-memory-one-door.md §2.2): a
 * read-only list of what the brain took in — nothing is typed in here, the Ask
 * bar is the one door. The URL stays /m/memory/capture so check-in pushes
 * (?checkin=1) and bookmarks keep landing; the check-in card and the
 * first-run tour live here as before. The list is memory.list_thoughts.
 */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }
  const userId = event.locals.user.id
  await ensureUserOntologySeeded(getDb(), userId)

  const [authUser, groundingQuestionEligible, recent] = await Promise.all([
    authDb
      .select({ onboardingCompleted: user.onboardingCompleted, accountKind: user.accountKind })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
      .then((rows) => rows[0]),
    isGroundingQuestionDue(userId), // shared check-in cadence (grounding | relevance)
    loadRecentCaptureThoughts(userId, BRAIN_KNOWS_LIMIT),
  ])

  return {
    onboardingCompleted: authUser?.accountKind === 'harness' || authUser?.onboardingCompleted === true,
    groundingQuestionEligible,
    recentThoughts: recent.recentThoughts,
    recentThoughtDetails: recent.recentThoughtDetails,
  }
}

async function completeOnboarding(locals: App.Locals) {
  if (!locals.user) {
    return fail(401, { message: 'Unauthorized' })
  }
  await authDb.update(user).set({ onboardingCompleted: true }).where(eq(user.id, locals.user.id))
  return { ok: true as const }
}

export const actions: Actions = {
  completeOnboarding: (event) => completeOnboarding(event.locals),
  skipOnboarding: (event) => completeOnboarding(event.locals),
}
