import type { OrchestratorEngineId } from '../../../../modules/orchestrator/engine-choice'
import { and, desc, eq } from 'drizzle-orm'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { getDb } from '$lib/server/db'
import { companyMail } from '$lib/server/mail'
import { kernelJourneys } from '$lib/server/db/journey.schema'
import { llmActiveProvider, llmProviderConfig, userPreference } from '$lib/server/db/schema'
import { WEBSITE_FOUNDING_JOURNEY } from '../../../../modules/orchestrator/brain'
import {
  websiteStatusFrom,
  type OnboardingFacts,
} from '../../../../modules/orchestrator/onboarding-context'

/**
 * DB-backed assisted-onboarding facts for the conversing human (wired by
 * boot.ts into the orchestrator runtime). Read-only; fails loud on DB errors.
 * Null when there is no human (principal-attributed turns).
 */
export async function onboardingFactsFor(
  llmUserId: string | undefined,
): Promise<OnboardingFacts | null> {
  if (!llmUserId) return null
  const db = getDb()
  const [pref] = await db
    .select({ welcomeCompletedAt: userPreference.welcomeCompletedAt })
    .from(userPreference)
    .where(eq(userPreference.userId, llmUserId))
    .limit(1)
  const emailConfigured = await companyMail().isConfigured()
  const [active] = await db
    .select({ provider: llmActiveProvider.provider })
    .from(llmActiveProvider)
    .where(eq(llmActiveProvider.userId, llmUserId))
    .limit(1)
  const [journey] = await db
    .select({ status: kernelJourneys.status })
    .from(kernelJourneys)
    .where(eq(kernelJourneys.kind, WEBSITE_FOUNDING_JOURNEY.kind))
    .orderBy(desc(kernelJourneys.createdAt))
    .limit(1)
  return {
    welcomeCompleted: pref?.welcomeCompletedAt != null,
    adminAccount: await isUserAdmin(llmUserId),
    email: emailConfigured,
    aiProvider: active !== undefined,
    website: websiteStatusFrom(journey?.status ?? null),
  }
}

/** The engine recorded at connect time for the user's ACTIVE provider (null = no BYOK provider). */
export async function recordedOrchestratorEngineFor(
  userId: string,
): Promise<OrchestratorEngineId | null> {
  const [row] = await getDb()
    .select({ engine: llmProviderConfig.orchestratorEngine })
    .from(llmActiveProvider)
    .innerJoin(
      llmProviderConfig,
      and(
        eq(llmProviderConfig.userId, llmActiveProvider.userId),
        eq(llmProviderConfig.provider, llmActiveProvider.provider),
      ),
    )
    .where(eq(llmActiveProvider.userId, userId))
    .limit(1)
  return row?.engine ?? null
}
