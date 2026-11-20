import { eq } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { llmActiveProvider } from '$lib/server/db/schema'
import { env } from '$lib/server/env/private-env'
import { readPlatformAiConfig } from '$lib/server/llm/platform-ai'
import { hasSavedByokLlmCredentials } from '$lib/server/llm/preferences'
import type { SlotSource } from '$lib/server/llm/slots'
import type { LlmProviderKind } from '$lib/server/llm/types'

function hasEnv(...names: Array<string | undefined>): boolean {
  return names.every((value) => Boolean(value?.trim()))
}

/**
 * eigenInference: mirrors loadEigenInferenceConfig — the hosting's PLATFORM_LLM_*, nothing
 * else. A partial platform AI throws (it fails loud at start too).
 */
function eigenInferenceConfigured(): boolean {
  return readPlatformAiConfig(env as Record<string, string | undefined>) !== null
}

/**
 * Own key: DB credentials first, then the BYOK env pair the settings page documents
 * (LLM_BASE_URL + LLM_API_KEY for EUrouter, OPENROUTER_* for OpenRouter).
 */
function byokEnvConfigured(provider: LlmProviderKind): boolean {
  if (provider === 'openrouter') {
    return hasEnv(env.OPENROUTER_BASE_URL, env.OPENROUTER_API_KEY)
  }
  return hasEnv(env.LLM_BASE_URL, env.LLM_API_KEY)
}

/**
 * Whether chat (and everything else going through the LLM gateway) can work on `source` with
 * this account's saved provider. Readiness hint for the onboarding provider step — NEVER an
 * execution gate: the gateway still fails loud with LlmNotConfiguredError when config is missing.
 */
export async function isUserProviderReady(userId: string, source: SlotSource): Promise<boolean> {
  if (source === 'eigeninference') return eigenInferenceConfigured()
  const [activeRow] = await getDb()
    .select({ provider: llmActiveProvider.provider })
    .from(llmActiveProvider)
    .where(eq(llmActiveProvider.userId, userId))
    .limit(1)
  const provider = (activeRow?.provider ?? 'eurouter') as LlmProviderKind

  if (await hasSavedByokLlmCredentials(userId)) return true
  return byokEnvConfigured(provider)
}

export type CompanyProviderReadyDeps = {
  companyAccountId: () => Promise<string | null>
  /** The company's source: the Settings → AI switch. */
  companySource: () => Promise<SlotSource>
  withDbUser: <T>(userId: string, fn: () => Promise<T>) => Promise<T>
  isUserProviderReady: (userId: string, source: SlotSource) => Promise<boolean>
}

const liveCompanyDeps: CompanyProviderReadyDeps = {
  companyAccountId: async () => (await import('./company-provider')).companyOwnerId(),
  companySource: async () => (await import('./slots')).companySlotSource(null),
  withDbUser: async (userId, fn) => (await import('$lib/server/db')).withDbUser(userId, () => fn()),
  isUserProviderReady,
}

/**
 * Whether the assistant can answer for anyone in this company: the company's source (the
 * Settings → AI switch) with the owner's account — the same resolution the gateway uses for
 * every member's calls (`slots.ts`); a member's own settings are irrelevant.
 * No owner yet → not ready.
 */
export async function isCompanyProviderReady(
  deps: CompanyProviderReadyDeps = liveCompanyDeps,
): Promise<boolean> {
  const account = await deps.companyAccountId()
  if (!account) return false
  const source = await deps.companySource()
  return deps.withDbUser(account, () => deps.isUserProviderReady(account, source))
}
