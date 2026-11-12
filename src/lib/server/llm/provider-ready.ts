import { eq } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { llmActiveProvider, userPreference } from '$lib/server/db/schema'
import { env } from '$lib/server/env/private-env'
import { hasSavedByokLlmCredentials } from '$lib/server/llm/preferences'
import type { LlmProviderKind } from '$lib/server/llm/types'

function hasEnv(...names: Array<string | undefined>): boolean {
  return names.every((value) => Boolean(value?.trim()))
}

/**
 * Platform credits path: mirrors loadPlatformLlmConfig's env requirements without
 * throwing — EUrouter service account by default, OpenRouter when the active row says so.
 */
function platformEnvConfigured(provider: LlmProviderKind): boolean {
  return provider === 'openrouter'
    ? hasEnv(env.OPENROUTER_BASE_URL, env.SERVICE_API_KEY_OPENROUTER)
    : hasEnv(env.LLM_BASE_URL, env.SERVICE_API_KEY_EUROUTER)
}

/**
 * BYOK path: DB credentials first, then the BYOK env pair the settings page documents
 * (LLM_BASE_URL + LLM_API_KEY for EUrouter, OPENROUTER_* for OpenRouter).
 */
async function byokEnvConfigured(provider: LlmProviderKind): Promise<boolean> {
  if (provider === 'openrouter') {
    return hasEnv(env.OPENROUTER_BASE_URL, env.OPENROUTER_API_KEY)
  }
  return hasEnv(env.LLM_BASE_URL, env.LLM_API_KEY)
}

/**
 * Whether chat (and everything else going through the LLM gateway) can work for this
 * user right now. Readiness hint for the onboarding provider step — NEVER an execution
 * gate: the gateway still fails loud with LlmNotConfiguredError when config is missing.
 */
export async function isUserProviderReady(userId: string): Promise<boolean> {
  const db = getDb()

  const [pref] = await db
    .select({ billingMode: userPreference.billingMode })
    .from(userPreference)
    .where(eq(userPreference.userId, userId))
    .limit(1)
  const billingMode = pref?.billingMode ?? 'platform_credits'

  const [activeRow] = await db
    .select({ provider: llmActiveProvider.provider })
    .from(llmActiveProvider)
    .where(eq(llmActiveProvider.userId, userId))
    .limit(1)
  const provider = (activeRow?.provider ?? 'eurouter') as LlmProviderKind

  if (billingMode === 'byok') {
    if (await hasSavedByokLlmCredentials(userId)) return true
    return byokEnvConfigured(provider)
  }
  return platformEnvConfigured(provider)
}

export type CompanyProviderReadyDeps = {
  companyAccountId: () => Promise<string | null>
  withDbUser: <T>(userId: string, fn: () => Promise<T>) => Promise<T>
  isUserProviderReady: (userId: string) => Promise<boolean>
}

const liveCompanyDeps: CompanyProviderReadyDeps = {
  companyAccountId: async () => (await import('./company-provider')).companyOwnerId(),
  withDbUser: async (userId, fn) => (await import('$lib/server/db')).withDbUser(userId, () => fn()),
  isUserProviderReady,
}

/**
 * Whether the assistant can answer for anyone in this company: the readiness of the
 * company's AI provider (the owner's account — the same one the gateway uses for every
 * member's turns, see `onCompanyProvider`); a member's own settings are irrelevant.
 * No owner yet → no company provider → not ready.
 */
export async function isCompanyProviderReady(
  deps: CompanyProviderReadyDeps = liveCompanyDeps,
): Promise<boolean> {
  const account = await deps.companyAccountId()
  if (!account) return false
  return deps.withDbUser(account, () => deps.isUserProviderReady(account))
}
