import type { AppDatabase } from '$lib/server/db/context'
import { llmActiveProvider, userPreference, type BillingMode } from '$lib/server/db/schema'
import { assertByokConfigured } from '$lib/server/llm/preferences'

/** The providers a person can make active (Settings → AI provider). */
export type ActivatableLlmProvider = 'eurouter' | 'openrouter'

/**
 * Makes one of the person's SAVED providers the active one and switches them to
 * BYOK billing — the single path behind Settings → AI provider and the agent's
 * settings.update. Fails loud when no BYOK credentials are saved.
 */
export async function setActiveLlmProvider(
  db: AppDatabase,
  userId: string,
  provider: ActivatableLlmProvider,
): Promise<void> {
  await assertByokConfigured(userId)
  await db
    .insert(llmActiveProvider)
    .values({ userId, provider })
    .onConflictDoUpdate({
      target: llmActiveProvider.userId,
      set: { provider, updatedAt: new Date() },
    })
  await db
    .insert(userPreference)
    .values({ userId, billingMode: 'byok' as BillingMode })
    .onConflictDoUpdate({
      target: userPreference.userId,
      set: { billingMode: 'byok' as BillingMode, updatedAt: new Date() },
    })
}
