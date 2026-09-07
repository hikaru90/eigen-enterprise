import { eq } from 'drizzle-orm'
import { decryptTenantValue } from '$lib/server/crypto/tenant-encryption'
import { withDbUser } from '$lib/server/db'
import { llmProviderConfig, userPreference, type BillingMode } from '$lib/server/db/schema'

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
        provider: llmProviderConfig.provider,
      })
      .from(llmProviderConfig)
      .where(eq(llmProviderConfig.userId, userId))

    const keys = await Promise.all(
      rows.map((r) =>
        r.apiKeyEncrypted
          ? decryptTenantValue({
              userId,
              table: 'llm_provider_config',
              column: 'api_key',
              ciphertext: r.apiKeyEncrypted,
            })
          : Promise.resolve(r.apiKey ?? ''),
      ),
    )
    return rows.some((r, idx) => Boolean(r.baseUrl?.trim() && keys[idx]?.trim()))
  })
}

export async function assertByokConfigured(userId: string): Promise<void> {
  const ok = await hasSavedByokLlmCredentials(userId)
  if (!ok) {
    throw new Error(
      'BYOK requires saved OpenRouter or EUrouter credentials under Settings → LLM → BYOK.',
    )
  }
}
