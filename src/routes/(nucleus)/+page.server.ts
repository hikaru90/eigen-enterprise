import { onboardingFactsFor } from '$lib/server/onboarding/assisted'
import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { userPreference } from '$lib/server/db/schema'
import { isUserProviderReady } from '$lib/server/llm/provider-ready'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { companyMail } from '$lib/server/mail'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }

  const userId = event.locals.user.id
  const [authUser] = await authDb
    .select({ accountKind: user.accountKind })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)

  const isHarness = authUser?.accountKind === 'harness'
  const providerReady = await isUserProviderReady(userId)

  // Welcome tour gate: shown until the user finishes (or skips) it once. Harness
  // accounts exist for automated verification — they never see product surfaces.
  let showWelcome = false
  let displayName: string | null = null
  if (!isHarness) {
    const [pref] = await getDb()
      .select({
        welcomeCompletedAt: userPreference.welcomeCompletedAt,
        displayName: userPreference.displayName,
      })
      .from(userPreference)
      .where(eq(userPreference.userId, userId))
      .limit(1)
    showWelcome = pref?.welcomeCompletedAt == null
    displayName = pref?.displayName ?? null
  }

  return {
    // First-run gate: without a working provider there is no product — the page IS the
    // setup wizard. Harness accounts bypass (they exist for automated verification).
    needsOnboarding: !isHarness && !providerReady,
    showWelcome,
    // Back from the provider's sign-in redirect (OpenRouter callback): don't replay the tour.
    returnedFromProvider: event.url.searchParams.get('provider') === 'connected',
    // The agent's onboarding hand-off only applies while the website is still to do.
    handoffAvailable: showWelcome && (await onboardingFactsFor(userId))?.website === 'not_started',
    byokUiEnabled: isByokUiEnabled(),
    displayName,
    // The owner sets up company email in the onboarding (sign-in codes depend on it).
    needsMail: !isHarness && (await isUserAdmin(userId)) && !(await companyMail().isConfigured()),
  }
}
