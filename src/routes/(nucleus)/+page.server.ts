import { onboardingFactsFor } from '$lib/server/onboarding/assisted'
import type { PageServerLoad } from './$types'
import { approvalModeFromResponse, type ApprovalMode } from '$lib/chat/approvals-client'
import {
  loadApprovalStatuses,
  loadCurrentConversation,
  loadPendingApprovalsByTool,
} from '$lib/server/chat/current-conversation'
import { nucleusTurnsFromPersisted, persistedApprovalIds } from './nucleus-chat'
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

  // The chat survives navigation: the current session and its stored turns come
  // from Postgres (chat_message), and new turns continue that same session id.
  const conversation = await loadCurrentConversation(getDb(), userId)
  const approvalStatuses = await loadApprovalStatuses(
    getDb(),
    persistedApprovalIds(conversation.messages),
  )

  // Approval mode dropdown: owner/admin only. A failed or malformed load is
  // shown as such in the page — never replaced by a default mode.
  const isAdmin = await isUserAdmin(userId)
  let approvalMode: { status: 'ok'; mode: ApprovalMode } | { status: 'unavailable' } | null = null
  if (isAdmin) {
    const res = await event.fetch('/api/approvals/mode')
    const mode = res.ok ? approvalModeFromResponse(await res.json()) : null
    if (!mode) console.error('[nucleus] approval mode load failed', { status: res.status })
    approvalMode = mode ? { status: 'ok', mode } : { status: 'unavailable' }
  }

  return {
    chatSessionId: conversation.sessionId,
    chatHistory: nucleusTurnsFromPersisted(
      conversation.messages,
      approvalStatuses,
      await loadPendingApprovalsByTool(getDb()),
    ),
    isAdmin,
    approvalMode,
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
    needsMail: !isHarness && isAdmin && !(await companyMail().isConfigured()),
  }
}
