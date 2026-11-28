import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { eq } from 'drizzle-orm'
import { splitDisplayName } from '$lib/server/auth-user-name'
import { getUserRole, isAdminRole } from '$lib/server/auth/user-role'
import { getHiddenTiles } from '$lib/server/dashboard/hidden-tiles'
import { getDb } from '$lib/server/db'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { userPreference } from '$lib/server/db/schema'
import { domainsFromEnv } from '$lib/server/domains/env'
import { errorReport } from '$lib/server/errors/report'
import { registrantDefaults } from '$lib/server/domains/registrant-defaults'
import { isCompanyProviderReady } from '$lib/server/llm/provider-ready'
import { companyMail } from '$lib/server/mail'
import { managedMailFromEnv } from '$lib/server/mail/managed-env'
import { companyOnboardingFor, joinedTheCompany } from '$lib/server/members/joined'
import { onboardingFactsFor } from '$lib/server/onboarding/assisted'
import { personRun, type PersonRunner } from '$lib/server/org/person-run'
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
  // invited (or open-join) member already gave their name and goes straight in.
  const companyOnboarding = companyOnboardingFor({
    role,
    invited: role !== 'owner' && (await joinedTheCompany({ id: userId, email: event.locals.user.email ?? '' })),
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

  // The owner sets up company email in the onboarding (sign-in codes depend on it): a domain, then the
  // sender address. With eigenEnterprise Mail that is still to do until a default sender exists, but there
  // are no keys (plan/managed-domains.md, "The two onboarding steps").
  const needsMail = !isHarness && isAdmin && !(await companyMail().isConfigured())
  const managedMail = managedMailFromEnv() !== null
  const canBuyDomain = domainsFromEnv() !== null

  return {
    needsOnboarding,
    providerMissing,
    showWelcome,
    // The dashboard (polish P-2) once the full-screen first-run tour is done.
    dashboard: showWelcome ? null : await loadDashboard(userId),
    // The tiles this person closed with their × (Contribute 06894ad7): hidden on every device.
    hiddenTiles: showWelcome ? [] : await getHiddenTiles(userId),
    greetingName: greetingName(event.locals.user, displayName),
    // Back from the provider's sign-in redirect (OpenRouter callback): don't replay the tour.
    returnedFromProvider: event.url.searchParams.get('provider') === 'connected',
    // The agent's onboarding hand-off only applies while the website is still to do.
    handoffAvailable: showWelcome && (await onboardingFactsFor(userId))?.website === 'not_started',
    byokUiEnabled: isByokUiEnabled(),
    displayName,
    needsMail,
    // The Domain act: buying is offered on managed boxes (EE_DOMAINS_*); the Email act needs no keys with eigenEnterprise Mail.
    domainSetup: needsMail
      ? {
          managedMail,
          canBuy: canBuyDomain,
          registrant: canBuyDomain && showWelcome ? await registrantDefaults(event.locals.user) : null,
        }
      : null,
  }
}

/** Overridable in tests. */
export const _dashboardDeps: { run: PersonRunner } = { run: personRun }

export const actions: Actions = {
  /**
   * A person answers a decision question in Needs you (CB2): decisions.answer as them, through
   * the kernel registry (the same tool the CLI and the brain use).
   */
  decisionAnswer: async ({ locals, request }) => {
    const user = locals.user
    if (!user) throw redirect(302, '/login')
    const form = await request.formData()
    const input = { decision_id: form.get('decision_id')?.toString() ?? '', choice: form.get('choice')?.toString() ?? '' }
    try {
      await _dashboardDeps.run(user, 'decisions.answer', input)
      return { action: 'decisionAnswer' as const, ok: true as const, decisionId: input.decision_id }
    } catch (err) {
      const refused = err instanceof KernelError
      if (!refused) console.error('[dashboard] decisions.answer failed', err)
      return fail(refused ? 400 : 500, {
        action: 'decisionAnswer' as const,
        decisionId: input.decision_id,
        ...errorReport(err, {
          attempted: 'Answering a decision question (Needs you)',
          tool: 'decisions.answer',
          input,
          plain: (e) => (e instanceof KernelError ? e.message : 'Your answer could not be saved. Try again.'),
          nextSteps: ['decisions.answer (src/lib/kernel/decision-tools.ts → src/lib/server/decisions/service.ts answerQuestion) refused or failed.'],
        }),
      })
    }
  },
  /** What's happening's Refresh (wish 75a4e570): dashboard.patterns_refresh as the person, through the registry. */
  patternsRefresh: async ({ locals }) => {
    const user = locals.user
    if (!user) throw redirect(302, '/login')
    try {
      await _dashboardDeps.run(user, 'dashboard.patterns_refresh', {})
      return { action: 'patternsRefresh' as const, ok: true as const }
    } catch (err) {
      const refused = err instanceof KernelError
      if (!refused) console.error('[dashboard] dashboard.patterns_refresh failed', err)
      return fail(refused ? 400 : 500, {
        action: 'patternsRefresh' as const,
        ...errorReport(err, {
          attempted: "Refreshing What's happening on the dashboard",
          tool: 'dashboard.patterns_refresh',
          input: {},
          plain: (e) => (e instanceof KernelError ? e.message : "What's happening could not be refreshed. Try again."),
          nextSteps: ['dashboard.patterns_refresh (src/lib/kernel/pattern-tools.ts → src/lib/server/patterns/service.ts refreshPatternDigest) refused or failed.'],
        }),
      })
    }
  },
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
