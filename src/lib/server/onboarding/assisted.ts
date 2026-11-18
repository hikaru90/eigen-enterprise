import { desc, eq } from 'drizzle-orm'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { getDb } from '$lib/server/db'
import { kernelJourneys } from '$lib/server/db/journey.schema'
import { llmActiveProvider, userPreference } from '$lib/server/db/schema'
import { companyMail } from '$lib/server/mail'
import { managedMailFromEnv } from '$lib/server/mail/managed-env'
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
  // eigenEnterprise Mail: nothing for the owner to connect, the step counts as done.
  const emailConfigured = (await companyMail().isConfigured()) || managedMailFromEnv() !== null
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
