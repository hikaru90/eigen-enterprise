import { encryptTenantValue } from '$lib/server/crypto/tenant-encryption'
import { getDb } from '$lib/server/db'
import {
  llmProviderConfig,
  llmActiveProvider,
  userPreference,
  type BillingMode,
} from '$lib/server/db/schema'

/** Widened with phase-2a: any models.dev catalog id or 'github_copilot'. */
export type LlmProviderId = string

export type SaveProviderConfigInput = {
  userId: string
  provider: LlmProviderId
  baseUrl: string
  /** Empty for oauth rows — the request credential is the rotated access token. */
  apiKey: string
  ruleChat?: string | null
  ruleEmbedding?: string | null
  modelChat?: string | null
  modelEmbedding?: string | null
  /** Upsert llm_active_provider (default true). billingMode always flips to byok. */
  setActive?: boolean
  /** OAuth credentials (Copilot subscription, …) — encrypted at rest. */
  oauth?: {
    access: string
    refresh: string
    expiresAt: Date | null
    meta?: Record<string, unknown> | null
  }
}

function assertValidProvider(provider: string): asserts provider is LlmProviderId {
  // Provider ids are free-form text (llm_provider_config.provider): 'eurouter',
  // 'openrouter', 'github_copilot', or any models.dev catalog id.
  if (!provider.trim()) {
    throw new Error('Invalid provider.')
  }
}

/**
 * Single persistence path for user-managed (BYOK) provider credentials. Used by both
 * Settings → LLM and the onboarding provider step — validation, tenant-encrypted key
 * storage, active-provider selection, and the billingMode → byok flip live here exactly
 * once. Throws plain Errors with user-safe messages; callers map them to their UX.
 */
export async function saveProviderConfig(input: SaveProviderConfigInput): Promise<void> {
  assertValidProvider(input.provider)
  const baseUrl = input.baseUrl.trim()
  const apiKey = input.apiKey.trim()
  const oauth = input.oauth
  if (!baseUrl) {
    throw new Error('Base URL is required.')
  }
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    throw new Error('Base URL must start with http:// or https://')
  }
  if (!oauth && !apiKey) {
    throw new Error('API key is required.')
  }

  const db = getDb()
  const userId = input.userId
  const authType: 'api_key' | 'oauth' = oauth ? 'oauth' : 'api_key'
  const apiKeyEncrypted = oauth
    ? null
    : await encryptTenantValue({
        userId,
        table: 'llm_provider_config',
        column: 'api_key',
        plaintext: apiKey,
      })
  const oauthAccessEncrypted = oauth
    ? await encryptTenantValue({
        userId,
        table: 'llm_provider_config',
        column: 'oauth_access',
        plaintext: oauth.access,
      })
    : null
  const oauthRefreshEncrypted = oauth
    ? await encryptTenantValue({
        userId,
        table: 'llm_provider_config',
        column: 'oauth_refresh',
        plaintext: oauth.refresh,
      })
    : null

  const values = {
    userId,
    provider: input.provider,
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    apiKeyEncrypted,
    authType,
    oauthAccessEncrypted,
    oauthRefreshEncrypted,
    oauthExpiresAt: oauth?.expiresAt ?? null,
    oauthMeta: oauth?.meta ?? null,
    ruleChat: input.ruleChat?.trim() || null,
    ruleEmbedding: input.ruleEmbedding?.trim() || null,
    modelChat: input.modelChat?.trim() || null,
    modelEmbedding: input.modelEmbedding?.trim() || null,
  }

  await db
    .insert(llmProviderConfig)
    .values(values)
    .onConflictDoUpdate({
      target: [llmProviderConfig.userId, llmProviderConfig.provider],
      set: { ...values, updatedAt: new Date() },
    })

  if (input.setActive !== false) {
    await db
      .insert(llmActiveProvider)
      .values({ userId, provider: input.provider })
      .onConflictDoUpdate({
        target: llmActiveProvider.userId,
        set: { provider: input.provider, updatedAt: new Date() },
      })
  }

  await db
    .insert(userPreference)
    .values({ userId, billingMode: 'byok' as BillingMode })
    .onConflictDoUpdate({
      target: userPreference.userId,
      set: { billingMode: 'byok' as BillingMode, updatedAt: new Date() },
    })
}

/**
 * Label used in user-facing save confirmations.
 */
export function providerLabel(provider: LlmProviderId): string {
  return provider === 'eurouter' ? 'EUrouter' : 'OpenRouter'
}
