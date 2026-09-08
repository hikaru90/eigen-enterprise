import { eq } from 'drizzle-orm'
import { decryptTenantValue } from '$lib/server/crypto/tenant-encryption'
import { withDbUser } from '$lib/server/db'
import { llmProviderConfig, userPreference, type BillingMode } from '$lib/server/db/schema'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'

export async function isByokBilling(userId: string): Promise<boolean> {
  return withDbUser(userId, async (db) => {
    const [row] = await db
      .select({ billingMode: userPreference.billingMode })
      .from(userPreference)
      .where(eq(userPreference.userId, userId))
      .limit(1)

    return ((row?.billingMode ?? 'platform_credits') as BillingMode) === 'byok'
  })
}

/** True when the user has at least one stored OpenRouter or EUrouter credential row. */
export async function hasSavedByokLlmCredentials(userId: string): Promise<boolean> {
  return withDbUser(userId, async (db) => {
    const rows = await db
      .select({
        baseUrl: llmProviderConfig.baseUrl,
        apiKey: llmProviderConfig.apiKey,
        apiKeyEncrypted: llmProviderConfig.apiKeyEncrypted,
        authType: llmProviderConfig.authType,
        oauthAccessEncrypted: llmProviderConfig.oauthAccessEncrypted,
        oauthRefreshEncrypted: llmProviderConfig.oauthRefreshEncrypted,
        provider: llmProviderConfig.provider,
      })
      .from(llmProviderConfig)
      .where(eq(llmProviderConfig.userId, userId))

    const keys = await Promise.all(
      rows.map((r) => {
        if ((r.authType ?? 'api_key') === 'oauth') {
          return Promise.resolve(
            Boolean(r.oauthAccessEncrypted || r.oauthRefreshEncrypted || r.apiKey?.trim()),
          )
        }
        return r.apiKeyEncrypted
          ? decryptTenantValue({
              userId,
              table: 'llm_provider_config',
              column: 'api_key',
              ciphertext: r.apiKeyEncrypted,
            }).then((key) => Boolean(key.trim()))
          : Promise.resolve(Boolean(r.apiKey?.trim()))
      }),
    )
    return rows.some((r, idx) => Boolean(r.baseUrl?.trim() && keys[idx]))
  })
}

export async function assertByokConfigured(userId: string): Promise<void> {
  const ok = await hasSavedByokLlmCredentials(userId)
  if (!ok) {
    throw new LlmNotConfiguredError(
      'BYOK requires saved OpenRouter or EUrouter credentials under Settings → LLM → BYOK.',
    )
  }
}
