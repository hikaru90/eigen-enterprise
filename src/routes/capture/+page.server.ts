import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { loadRecentCaptureThoughts } from '$lib/server/capture/load-recent-capture-thoughts'
import { getDb } from '$lib/server/db'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { userPreference } from '$lib/server/db/schema'
import { getSafeErrorMessage } from '$lib/server/settings/llm-page.server'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'
import {
  providerLabel,
  saveProviderConfig,
  type LlmProviderId,
} from '$lib/server/llm/save-provider-config'
import { isUserProviderReady } from '$lib/server/llm/provider-ready'
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

  const [pref, groundingQuestionEligible, providerReady] = await Promise.all([
    getDb()
      .select({ preferredLanguage: userPreference.preferredLanguage })
      .from(userPreference)
      .where(eq(userPreference.userId, userId))
      .limit(1)
      .then((rows) => rows[0]),
    isGroundingQuestionDue(userId), // shared check-in cadence (grounding | relevance)
    isUserProviderReady(userId),
  ])

  const { recentThoughts, recentThoughtDetails } = await loadRecentCaptureThoughts(userId)

  return {
    user: event.locals.user,
    isHarness,
    onboardingCompleted: isHarness || authUser?.onboardingCompleted === true,
    preferredLanguage: pref?.preferredLanguage ?? 'en',
    groundingQuestionEligible,
    providerReady,
    byokUiEnabled: isByokUiEnabled(),
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

  /**
   * Onboarding provider step — same persistence path as Settings → LLM (BYOK).
   * Gated by the same BYOK-UI flag; when it is disabled the deployment expects the
   * operator to configure the platform service account via env instead.
   */
  saveProvider: async (event) => {
    if (!event.locals.user) {
      return fail(401, { providerMessage: 'You must be signed in.' })
    }
    if (!isByokUiEnabled()) {
      return fail(403, {
        providerMessage: 'Bring your own key is not available on this deployment.',
      })
    }

    const formData = await event.request.formData()
    const provider = formData.get('provider')?.toString().trim() ?? ''
    const baseUrl = formData.get('baseUrl')?.toString().trim() ?? ''
    const apiKey = formData.get('apiKey')?.toString().trim() ?? ''
    const ruleChat = formData.get('ruleChat')?.toString().trim() || null
    const ruleEmbedding = formData.get('ruleEmbedding')?.toString().trim() || null
    const modelChat = formData.get('modelChat')?.toString().trim() || null
    const modelEmbedding = formData.get('modelEmbedding')?.toString().trim() || null

    try {
      await saveProviderConfig({
        userId: event.locals.user.id,
        provider: provider as LlmProviderId,
        baseUrl,
        apiKey,
        ruleChat,
        ruleEmbedding,
        modelChat,
        modelEmbedding,
        setActive: true,
      })
      return {
        providerMessage: `${providerLabel(provider as LlmProviderId)} connected.`,
      }
    } catch (error) {
      return fail(400, {
        providerMessage: getSafeErrorMessage(error, 'Unable to save provider configuration.'),
      })
    }
  },
}
