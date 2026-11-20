import { and, eq } from 'drizzle-orm'
import { decryptTenantValue, encryptTenantValue } from '$lib/server/crypto/tenant-encryption'
import { getDb, withDbUser } from '$lib/server/db'
import { llmActiveProvider, llmProviderConfig } from '$lib/server/db/schema'
import { env } from '$lib/server/env/private-env'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import { assertEurouterGatewayConfigured } from '$lib/server/llm/llm-config-guard'
import { copilotChatBaseUrl, fetchCopilotAccessToken } from '$lib/server/llm/oauth/github-copilot'
import type { LlmProviderKind, ResolvedLlmConfig } from '$lib/server/llm/types'

/**
 * Bring-your-own-key credentials (Settings → AI → Advanced): the provider rows saved on an
 * account (the company's are on the owner's account, see `company-provider.ts`), decrypted,
 * OAuth tokens rotated. Moved out of llm-client.ts unchanged for CB1, so the slot resolver
 * (`slots.ts`) and the gateway share one loader.
 */

/**
 * Loads credentials for a specific LLM provider. DB rows take priority over environment variables.
 */
export async function loadLlmProviderConfig(
  userId: string,
  provider: LlmProviderKind,
): Promise<ResolvedLlmConfig> {
  const row = await withDbUser(userId, async (db) => {
    const [loaded] = await db
      .select()
      .from(llmProviderConfig)
      .where(and(eq(llmProviderConfig.userId, userId), eq(llmProviderConfig.provider, provider)))
      .limit(1)
    if (!loaded?.baseUrl) return null

    const authType = (loaded.authType ?? 'api_key') as 'api_key' | 'oauth'
    if (authType === 'oauth') {
      const access = loaded.oauthAccessEncrypted
        ? await decryptTenantValue({
            userId,
            table: 'llm_provider_config',
            column: 'oauth_access',
            ciphertext: loaded.oauthAccessEncrypted,
          })
        : ''
      const refresh = loaded.oauthRefreshEncrypted
        ? await decryptTenantValue({
            userId,
            table: 'llm_provider_config',
            column: 'oauth_refresh',
            ciphertext: loaded.oauthRefreshEncrypted,
          })
        : ''
      const expiresAtMs = loaded.oauthExpiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER

      // Rotating OAuth: re-exchange the long-lived token when expired and persist the
      // rotated access token. Non-expiring OAuth (OpenRouter key) passes through.
      if ((!access || Date.now() >= expiresAtMs) && refresh) {
        let rotated: {
          access: string
          refresh: string
          expiresAtMs: number
          meta?: Record<string, unknown> | null
        }
        if (provider === 'github_copilot') {
          const session = await fetchCopilotAccessToken(refresh)
          rotated = {
            access: session.access,
            refresh: session.refresh,
            expiresAtMs: session.expiresAtMs,
            meta: { availableModelIds: session.availableModelIds },
          }
        } else {
          rotated = { access, refresh, expiresAtMs: Number.MAX_SAFE_INTEGER, meta: null }
        }
        const oauthAccessEncrypted = await encryptTenantValue({
          userId,
          table: 'llm_provider_config',
          column: 'oauth_access',
          plaintext: rotated.access,
        })
        const oauthRefreshEncrypted =
          rotated.refresh === refresh
            ? (loaded.oauthRefreshEncrypted ?? null)
            : await encryptTenantValue({
                userId,
                table: 'llm_provider_config',
                column: 'oauth_refresh',
                plaintext: rotated.refresh,
              })
        await getDb()
          .update(llmProviderConfig)
          .set({
            oauthAccessEncrypted,
            oauthRefreshEncrypted,
            oauthExpiresAt: new Date(rotated.expiresAtMs),
            oauthMeta: rotated.meta ?? loaded.oauthMeta ?? null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(llmProviderConfig.userId, userId), eq(llmProviderConfig.provider, provider)),
          )
        const baseUrl =
          provider === 'github_copilot'
            ? copilotChatBaseUrl(rotated.access)
            : (loaded.baseUrl?.replace(/\/$/, '') ?? '')
        return {
          provider,
          baseUrl,
          apiKey: rotated.access,
          ruleChat: loaded.ruleChat,
          ruleEmbedding: loaded.ruleEmbedding,
          modelChat: loaded.modelChat,
          modelEmbedding: loaded.modelEmbedding,
        }
      }

      if (!access) {
        throw new LlmNotConfiguredError(
          `${provider} credential needs to be renewed — connect it again under Settings → LLM.`,
        )
      }

      const baseUrl =
        provider === 'github_copilot'
          ? copilotChatBaseUrl(access)
          : loaded.baseUrl.replace(/\/$/, '')
      return {
        provider,
        baseUrl,
        apiKey: access,
        ruleChat: loaded.ruleChat,
        ruleEmbedding: loaded.ruleEmbedding,
        modelChat: loaded.modelChat,
        modelEmbedding: loaded.modelEmbedding,
      }
    }

    const apiKey = loaded.apiKeyEncrypted
      ? await decryptTenantValue({
          userId,
          table: 'llm_provider_config',
          column: 'api_key',
          ciphertext: loaded.apiKeyEncrypted,
        })
      : (loaded.apiKey ?? '')
    if (!apiKey.trim()) return null

    return { ...loaded, apiKey }
  })

  if (row?.baseUrl && row.apiKey) {
    const baseUrl = row.baseUrl.replace(/\/$/, '')
    const ruleChat = row.ruleChat?.trim() || null
    const ruleEmbedding = row.ruleEmbedding?.trim() || null
    if (provider === 'eurouter') {
      assertEurouterGatewayConfigured({
        baseUrl,
        ruleChat,
        ruleEmbedding,
        context: 'byok',
      })
    }
    return {
      provider,
      baseUrl,
      apiKey: row.apiKey,
      ruleChat,
      ruleEmbedding,
      modelChat: row.modelChat?.trim() || null,
      modelEmbedding: row.modelEmbedding?.trim() || null,
    }
  }

  if (provider === 'openrouter') {
    const baseUrl = env.OPENROUTER_BASE_URL?.trim()
    const apiKey = env.OPENROUTER_API_KEY?.trim()
    if (!baseUrl) {
      throw new LlmNotConfiguredError(
        'OpenRouter not configured for speech-to-text: set OPENROUTER_BASE_URL or save OpenRouter credentials in Settings → LLM Provider',
      )
    }
    if (!apiKey) {
      throw new LlmNotConfiguredError(
        'OpenRouter not configured for speech-to-text: set OPENROUTER_API_KEY or save OpenRouter credentials in Settings → LLM Provider',
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

  const baseUrl = env.LLM_BASE_URL?.trim()
  const apiKey = env.LLM_API_KEY?.trim()
  if (!baseUrl) {
    throw new LlmNotConfiguredError(
      'LLM not configured: set LLM_BASE_URL in environment or configure via Settings → LLM Provider',
    )
  }
  if (!apiKey) {
    throw new LlmNotConfiguredError(
      'LLM not configured: set LLM_API_KEY in environment or configure via Settings → LLM Provider',
    )
  }

  const ruleChat = env.LLM_RULE_CHAT?.trim() || null
  const ruleEmbedding = env.LLM_RULE_EMBEDDING?.trim() || null
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  assertEurouterGatewayConfigured({
    baseUrl: normalizedBaseUrl,
    ruleChat,
    ruleEmbedding,
    context: 'byok',
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

/** Active provider row + DB/env credentials (EUrouter or OpenRouter BYOK shapes). */
export async function resolveActiveProviderLlmConfig(userId: string): Promise<ResolvedLlmConfig> {
  const [activeRow] = await withDbUser(userId, async (db) =>
    db.select().from(llmActiveProvider).where(eq(llmActiveProvider.userId, userId)).limit(1),
  )
  const provider = (activeRow?.provider ?? 'eurouter') as LlmProviderKind
  return loadLlmProviderConfig(userId, provider)
}
