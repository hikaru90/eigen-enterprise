import { eq } from 'drizzle-orm'
import { withBillingUserDbRead } from '$lib/server/db/billing-db-read'
import { llmActiveProvider } from '$lib/server/db/schema'
import { env } from '$lib/server/env/private-env'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import { assertEurouterGatewayConfigured } from '$lib/server/llm/llm-config-guard'
import {
  PLATFORM_AI_PROVIDER,
  readPlatformAiConfig,
  type PlatformAiConfig,
} from '$lib/server/llm/platform-ai'
import type { LlmProviderKind, ResolvedLlmConfig } from '$lib/server/llm/types'

/** This process's platform AI from hosting (PLATFORM_LLM_*), or null. Throws on a partial set. */
export function platformAiFromEnv(): PlatformAiConfig | null {
  return readPlatformAiConfig(env as Record<string, string | undefined>)
}

/**
 * Platform-managed gateway credentials. Used when billing_mode is platform_credits.
 * The platform AI from hosting (a hosted box) first; otherwise the self-hosted
 * service account: EUrouter by default, OpenRouter when the active row says so.
 */
export async function loadPlatformLlmConfig(userId: string): Promise<ResolvedLlmConfig> {
  const platformAi = platformAiFromEnv()
  if (platformAi) {
    return {
      provider: PLATFORM_AI_PROVIDER,
      baseUrl: platformAi.baseUrl,
      apiKey: platformAi.apiKey,
      ruleChat: null,
      ruleEmbedding: null,
      modelChat: platformAi.modelChat,
      modelEmbedding: platformAi.modelEmbedding,
    }
  }

  const [activeRow] = await withBillingUserDbRead(userId, (db) =>
    db.select().from(llmActiveProvider).where(eq(llmActiveProvider.userId, userId)).limit(1),
  )
  const provider = (activeRow?.provider ?? 'eurouter') as LlmProviderKind

  if (provider === 'openrouter') {
    const baseUrl = env.OPENROUTER_BASE_URL?.trim()
    const apiKey = env.SERVICE_API_KEY_OPENROUTER?.trim()
    if (!baseUrl) {
      throw new LlmNotConfiguredError('Platform OpenRouter not configured: set OPENROUTER_BASE_URL')
    }
    if (!apiKey) {
      throw new LlmNotConfiguredError(
        'Platform OpenRouter not configured: set SERVICE_API_KEY_OPENROUTER',
      )
    }
    return {
      provider: 'openrouter',
      baseUrl: baseUrl.replace(/\/$/, ''),
      apiKey,
      ruleChat: null,
      ruleEmbedding: null,
      modelChat: env.LLM_MODEL_CHAT?.trim() || null,
      modelEmbedding: env.LLM_MODEL_EMBEDDING?.trim() || null,
    }
  }

  const baseUrl = env.LLM_BASE_URL?.trim()
  const apiKey = env.SERVICE_API_KEY_EUROUTER?.trim()
  if (!baseUrl) {
    throw new LlmNotConfiguredError('Platform EUrouter not configured: set LLM_BASE_URL')
  }
  if (!apiKey) {
    throw new LlmNotConfiguredError('Platform EUrouter not configured: set SERVICE_API_KEY_EUROUTER')
  }
  const ruleChat = env.LLM_RULE_CHAT?.trim() || null
  const ruleEmbedding = env.LLM_RULE_EMBEDDING?.trim() || null
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  assertEurouterGatewayConfigured({
    baseUrl: normalizedBaseUrl,
    ruleChat,
    ruleEmbedding,
    context: 'platform',
  })
  return {
    provider: 'eurouter',
    baseUrl: normalizedBaseUrl,
    apiKey,
    ruleChat,
    ruleEmbedding,
    modelChat: null,
    modelEmbedding: null,
  }
}

export async function loadPlatformOpenRouterSttConfig(): Promise<ResolvedLlmConfig> {
  const baseUrl = env.OPENROUTER_BASE_URL?.trim()
  const apiKey = env.SERVICE_API_KEY_OPENROUTER?.trim()
  if (!baseUrl) {
    throw new LlmNotConfiguredError(
      'Platform OpenRouter STT not configured: set OPENROUTER_BASE_URL',
    )
  }
  if (!apiKey) {
    throw new LlmNotConfiguredError(
      'Platform OpenRouter STT not configured: set SERVICE_API_KEY_OPENROUTER',
    )
  }
  return {
    provider: 'openrouter',
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    ruleChat: null,
    ruleEmbedding: null,
    modelChat: null,
    modelEmbedding: null,
  }
}
