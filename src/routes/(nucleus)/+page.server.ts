import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { splitDisplayName } from '$lib/server/auth-user-name'
import { getUserRole, isAdminRole } from '$lib/server/auth/user-role'
import { getDb } from '$lib/server/db'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { userPreference } from '$lib/server/db/schema'
import { isCompanyProviderReady } from '$lib/server/llm/provider-ready'
import { companyMail } from '$lib/server/mail'
import { companyOnboardingFor, joinedByInvite } from '$lib/server/members/joined'
import { onboardingFactsFor } from '$lib/server/onboarding/assisted'
import { completeWelcomeOnboarding, setAccountName } from '$lib/server/onboarding/welcome'
import { loadDashboard } from '$lib/server/overview/dashboard'
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
  const providerReady = await isCompanyProviderReady()
  const role = await getUserRole(userId)
  const isAdmin = isAdminRole(role)
  // The company onboarding is the owner's (see companyOnboardingFor): an
  // invited member already gave their name and goes straight into the app.
  const companyOnboarding = companyOnboardingFor({
    role,
    invited: role !== 'owner' && (await joinedByInvite(event.locals.user.email ?? '')),
    providerReady,
  })

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
    showWelcome = companyOnboarding && pref?.welcomeCompletedAt == null
    displayName = pref?.displayName ?? null
    if (!companyOnboarding && pref?.welcomeCompletedAt == null) {
      // First arrival of an invited member: no company setup — into Messages.
      await completeWelcomeOnboarding(userId)
      throw redirect(303, '/messages')
    }
    // A name given before it was saved to the account (older installs): heal it.
    if (displayName && !event.locals.user.name?.trim()) await setAccountName(userId, displayName)
  }

  // First-run gate: without a working provider there is no product — the page IS the
  // setup wizard. Harness accounts bypass (they exist for automated verification).
  // The full-screen gate holds only inside the first-run tour (the wizard's provider
  // step). Once the tour is done, `/` is always the company dashboard; a missing
  // provider becomes a notice there that links to the connect step.
  const providerMissing = !isHarness && companyOnboarding && !providerReady
  const needsOnboarding = providerMissing && showWelcome

  return {
    needsOnboarding,
    providerMissing,
    showWelcome,
    // The dashboard (polish P-2) once the full-screen first-run tour is done.
    dashboard: showWelcome ? null : await loadDashboard(userId),
    greetingName: greetingName(event.locals.user, displayName),
    // Back from the provider's sign-in redirect (OpenRouter callback): don't replay the tour.
    returnedFromProvider: event.url.searchParams.get('provider') === 'connected',
    // The agent's onboarding hand-off only applies while the website is still to do.
    handoffAvailable: showWelcome && (await onboardingFactsFor(userId))?.website === 'not_started',
    byokUiEnabled: isByokUiEnabled(),
    displayName,
    // The owner sets up company email in the onboarding (sign-in codes depend on it).
    needsMail: !isHarness && isAdmin && !(await companyMail().isConfigured()),
  }
}

/** The dashboard greets by first name: the account's, else split from its name or the onboarding name. */
function greetingName(
  account: { firstName?: string | null; name?: string | null },
  displayName: string | null,
): string | null {
  return (
    account.firstName?.trim() ||
    splitDisplayName(account.name ?? '').firstName ||
    splitDisplayName(displayName ?? '').firstName ||
    null
  )
}
