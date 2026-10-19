import type { Actions, RequestEvent } from '@sveltejs/kit'
import { fail, redirect } from '@sveltejs/kit'
import { and, eq } from 'drizzle-orm'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { decryptTenantValue } from '$lib/server/crypto/tenant-encryption'
import { getDb } from '$lib/server/db'
import {
  userPreference,
  llmProviderConfig,
  llmActiveProvider,
  type BillingMode,
} from '$lib/server/db/schema'
import { env } from '$lib/server/env/private-env'
import { assertByokConfigured } from '$lib/server/llm/preferences'
import {
  providerLabel,
  saveProviderConfig,
  type LlmProviderId,
} from '$lib/server/llm/save-provider-config'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'
import { engineForProvider } from '../../../../modules/orchestrator/engine-choice'

export type { LlmProviderId } from '$lib/server/llm/save-provider-config'

export function getSafeErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message || fallback
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const msg = (error as { message?: unknown }).message
    if (typeof msg === 'string' && msg.trim().length > 0) return msg
  }
  return fallback
}

export function isProviderConfigured(
  row: { baseUrl?: string | null; apiKey?: string | null } | undefined,
) {
  return Boolean(row?.baseUrl?.trim() && row?.apiKey?.trim())
}

export async function loadLlmSettingsPage(event: RequestEvent) {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }

  const userId = event.locals.user.id
  const isAdmin = await isUserAdmin(userId)

  const [activeRow] = await getDb()
    .select({ provider: llmActiveProvider.provider })
    .from(llmActiveProvider)
    .where(eq(llmActiveProvider.userId, userId))
    .limit(1)

  const activeProvider = (activeRow?.provider ?? 'eurouter') as LlmProviderId

  const providerRows = await getDb()
    .select()
    .from(llmProviderConfig)
    .where(eq(llmProviderConfig.userId, userId))

  const eurouterRow = providerRows.find((r) => r.provider === 'eurouter')
  const openrouterRow = providerRows.find((r) => r.provider === 'openrouter')
  const [eurouterApiKey, openrouterApiKey] = await Promise.all([
    eurouterRow?.apiKeyEncrypted
      ? decryptTenantValue({
          userId,
          table: 'llm_provider_config',
          column: 'api_key',
          ciphertext: eurouterRow.apiKeyEncrypted,
        })
      : Promise.resolve(eurouterRow?.apiKey ?? ''),
    openrouterRow?.apiKeyEncrypted
      ? decryptTenantValue({
          userId,
          table: 'llm_provider_config',
          column: 'api_key',
          ciphertext: openrouterRow.apiKeyEncrypted,
        })
      : Promise.resolve(openrouterRow?.apiKey ?? ''),
  ])
  const byokConfigured = Boolean(
    (eurouterRow?.baseUrl?.trim() && eurouterApiKey.trim()) ||
    (openrouterRow?.baseUrl?.trim() && openrouterApiKey.trim()),
  )

  return {
    isAdmin,
    byokConfigured,
    activeProvider,
    providers: {
      eurouter: {
        configured: isProviderConfigured(eurouterRow),
        baseUrl: eurouterRow?.baseUrl ?? '',
        apiKey: eurouterApiKey,
        ruleChat: eurouterRow?.ruleChat ?? '',
        ruleEmbedding: eurouterRow?.ruleEmbedding ?? '',
        modelChat: eurouterRow?.modelChat || env.LLM_MODEL_CHAT?.trim() || '',
        modelEmbedding: eurouterRow?.modelEmbedding || env.LLM_MODEL_EMBEDDING?.trim() || '',
      },
      openrouter: {
        configured: isProviderConfigured(openrouterRow),
        baseUrl: openrouterRow?.baseUrl ?? '',
        apiKey: openrouterApiKey,
        modelChat: openrouterRow?.modelChat || env.LLM_MODEL_CHAT?.trim() || '',
        modelEmbedding: openrouterRow?.modelEmbedding || env.LLM_MODEL_EMBEDDING?.trim() || '',
      },
    },
  }
}

export const llmSettingsActions: Actions = {
  saveLlmConfig: async (event) => {
    if (!event.locals.user) {
      return fail(401, { llmMessage: 'You must be signed in.' })
    }
    if (!isByokUiEnabled()) {
      return fail(403, { llmMessage: 'Bring your own key is not available on this deployment.' })
    }

    const formData = await event.request.formData()
    const provider = formData.get('provider')?.toString().trim() ?? ''
    const baseUrl = formData.get('baseUrl')?.toString().trim() ?? ''
    const apiKey = formData.get('apiKey')?.toString().trim() ?? ''
    const ruleChat = formData.get('ruleChat')?.toString().trim() || null
    const ruleEmbedding = formData.get('ruleEmbedding')?.toString().trim() || null
    const modelChat = formData.get('modelChat')?.toString().trim() || null
    const modelEmbedding = formData.get('modelEmbedding')?.toString().trim() || null
    const setActive = formData.get('setActive') !== 'false'

    try {
      // Single persistence path shared with the onboarding provider step.
      await saveProviderConfig({
        userId: event.locals.user.id,
        provider: provider as LlmProviderId,
        baseUrl,
        apiKey,
        ruleChat,
        ruleEmbedding,
        modelChat,
        modelEmbedding,
        setActive,
      })
      return { llmMessage: `${providerLabel(provider as LlmProviderId)} saved.` }
    } catch (error) {
      return fail(400, {
        llmMessage: getSafeErrorMessage(error, 'Unable to save LLM configuration.'),
      })
    }
  },

  setActiveProvider: async (event) => {
    if (!event.locals.user) {
      return fail(401, { llmMessage: 'You must be signed in.' })
    }
    if (!isByokUiEnabled()) {
      return fail(403, { llmMessage: 'Bring your own key is not available on this deployment.' })
    }

    const formData = await event.request.formData()
    const provider = formData.get('provider')?.toString().trim() ?? ''

    if (provider !== 'eurouter' && provider !== 'openrouter') {
      return fail(400, { llmMessage: 'Invalid provider.' })
    }

    try {
      const userId = event.locals.user.id
      await assertByokConfigured(userId)
      const db = getDb()
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
      return {
        llmMessage: `Active provider set to ${provider === 'eurouter' ? 'EUrouter' : 'OpenRouter'}.`,
      }
    } catch (error) {
      return fail(400, {
        llmMessage: getSafeErrorMessage(error, 'Unable to set active provider.'),
      })
    }
  },

  saveModelConfig: async (event) => {
    if (!event.locals.user) {
      return fail(401, { modelMessage: 'You must be signed in.' })
    }

    const isAdmin = await isUserAdmin(event.locals.user.id)
    if (!isAdmin) {
      return fail(403, { modelMessage: 'Only administrators can modify model configuration.' })
    }

    const formData = await event.request.formData()
    const modelChat = formData.get('modelChat')?.toString().trim() || null
    const modelEmbedding = formData.get('modelEmbedding')?.toString().trim() || null
    const ruleChat = formData.get('ruleChat')?.toString().trim() || null
    const ruleEmbedding = formData.get('ruleEmbedding')?.toString().trim() || null
    const provider = formData.get('provider')?.toString().trim() || 'eurouter'

    if (provider !== 'eurouter' && provider !== 'openrouter') {
      return fail(400, { modelMessage: 'Invalid provider.' })
    }

    try {
      const db = getDb()
      const userId = event.locals.user.id

      // For EUrouter, use routing rules; for OpenRouter, use model names
      const isEurouter = provider === 'eurouter'
      const updateData = isEurouter
        ? { ruleChat, ruleEmbedding, updatedAt: new Date() }
        : { modelChat, modelEmbedding, updatedAt: new Date() }

      // Update or insert provider config
      const existing = await db
        .select()
        .from(llmProviderConfig)
        .where(and(eq(llmProviderConfig.userId, userId), eq(llmProviderConfig.provider, provider)))
        .limit(1)

      if (existing.length > 0 && existing[0]?.baseUrl) {
        await db
          .update(llmProviderConfig)
          .set(updateData)
          .where(
            and(eq(llmProviderConfig.userId, userId), eq(llmProviderConfig.provider, provider)),
          )
      } else {
        await db
          .insert(llmProviderConfig)
          .values({
            userId,
            provider,
            baseUrl:
              provider === 'openrouter'
                ? env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1'
                : env.LLM_BASE_URL?.trim() || 'https://api.eurouter.ai/v1',
            apiKey:
              provider === 'openrouter'
                ? env.OPENROUTER_API_KEY?.trim() || 'placeholder'
                : env.LLM_API_KEY?.trim() || 'placeholder',
            ...updateData,
            orchestratorEngine: engineForProvider(provider).engine,
          })
          .onConflictDoUpdate({
            target: [llmProviderConfig.userId, llmProviderConfig.provider],
            set: updateData,
          })
      }

      return { modelMessage: 'Configuration saved.' }
    } catch (error) {
      return fail(400, {
        modelMessage: getSafeErrorMessage(error, 'Unable to save configuration.'),
      })
    }
  },
}
