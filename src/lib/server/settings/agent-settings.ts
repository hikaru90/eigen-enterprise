import { and, eq } from 'drizzle-orm'
import { KernelError } from '$lib/kernel/errors'
import type { SettingChange, SettingsPort, SettingsView } from '$lib/kernel/settings-tools'
import { getUserRole } from '$lib/server/auth/user-role'
import { saveCompanyName } from '$lib/server/company/service'
import { companyProfileStore } from '$lib/server/company/store'
import { withDbUser } from '$lib/server/db'
import { llmActiveProvider, llmProviderConfig } from '$lib/server/db/schema'
import { setActiveLlmProvider } from '$lib/server/llm/active-provider'
import {
  CompanyAiInputError,
  readCompanyAiView,
  setCompanySlotModel,
  setCompanyUseEigenInference,
} from '$lib/server/llm/company-ai-settings'
import { companyOwnerId, onCompanyProvider } from '$lib/server/llm/company-provider'
import { describeChatModel } from '$lib/server/llm/llm-client'
import { companyIdentity } from '$lib/server/overview/sources'
import { getProfile } from '$lib/server/profile/service'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'

/**
 * The live SettingsPort behind kernel.whoami / settings.get / settings.update
 * ($lib/kernel/settings-tools). The company's AI provider is the one on the
 * owner's account (company-provider.ts), so AI settings are read from and
 * written to the owner's rows. Nothing here ever returns a credential.
 */

async function requireOwner(): Promise<string> {
  const owner = await companyOwnerId()
  if (!owner) {
    throw new KernelError('not_configured', 'The company has no owner yet, so it has no company settings.')
  }
  return owner
}

/** A provider row has credentials (a key, an encrypted key, or an oauth token) — never the values. */
function hasCredentials(row: typeof llmProviderConfig.$inferSelect): boolean {
  return Boolean(
    row.baseUrl?.trim() &&
      (row.apiKey?.trim() || row.apiKeyEncrypted || row.oauthAccessEncrypted || row.oauthRefreshEncrypted),
  )
}

async function read(): Promise<SettingsView> {
  const owner = await requireOwner()
  return withDbUser(owner, async (db) => {
    const identity = await companyIdentity()
    const [active] = await db
      .select({ provider: llmActiveProvider.provider })
      .from(llmActiveProvider)
      .where(eq(llmActiveProvider.userId, owner))
      .limit(1)
    const rows = await db.select().from(llmProviderConfig).where(eq(llmProviderConfig.userId, owner))
    const companyAi = await readCompanyAiView()
    return {
      company: { name: identity.name, hasLogo: identity.logo !== null },
      ai: {
        eigenInference: companyAi.useEigenInference,
        slots: companyAi.slots.map(({ slot, model, pick }) => ({ slot, model, pick })),
        embeddingModel: companyAi.embeddingModel,
        // The same default the gateway applies when no row exists (llm-client resolveActiveProviderLlmConfig).
        activeProvider: active?.provider ?? 'eurouter',
        // the company's source (CB1), not the owner's old per-account billing mode
        billing: companyAi.useEigenInference ? 'platform' : 'byok',
        providers: rows.map((row) => ({
          provider: row.provider,
          configured: hasCredentials(row),
          authType: row.authType,
          modelChat: row.modelChat?.trim() || null,
          modelEmbedding: row.modelEmbedding?.trim() || null,
          ruleChat: row.ruleChat?.trim() || null,
          ruleEmbedding: row.ruleEmbedding?.trim() || null,
        })),
      },
    }
  })
}

/** Updates one column of one SAVED provider row of the owner; a provider never saved fails loud. */
async function setProviderColumn(
  owner: string,
  provider: string,
  set: { modelChat: string } | { ruleChat: string },
): Promise<void> {
  const updated = await withDbUser(owner, (db) =>
    db
      .update(llmProviderConfig)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(llmProviderConfig.userId, owner), eq(llmProviderConfig.provider, provider)))
      .returning({ provider: llmProviderConfig.provider }),
  )
  if (updated.length === 0) {
    throw new KernelError(
      'invalid_input',
      `The company has no saved ${provider} provider. The owner sets it up in Settings → AI provider first.`,
      { provider },
    )
  }
}

async function apply(change: SettingChange, actorUserId: string): Promise<void> {
  switch (change.setting) {
    case 'company_name': {
      const saved = await withDbUser(actorUserId, () =>
        saveCompanyName(change.value, actorUserId, { store: companyProfileStore() }),
      )
      if (!saved.ok) throw new KernelError('invalid_input', saved.error)
      return
    }
    case 'ai_active_provider': {
      if (!isByokUiEnabled()) {
        throw new KernelError('not_configured', 'Choosing the AI provider is not available on this deployment.')
      }
      const owner = await requireOwner()
      await withDbUser(owner, (db) => setActiveLlmProvider(db, owner, change.value))
      return
    }
    case 'ai_chat_model': {
      if (change.provider === 'openrouter') {
        throw new KernelError(
          'invalid_input',
          'An OpenRouter key runs the company’s chat slot (CB1): change ai_slot_model {slot: chat} instead.',
        )
      }
      if (change.provider === 'eurouter') {
        throw new KernelError(
          'invalid_input',
          'EUrouter routes by routing rule, not model name: change ai_chat_routing_rule instead.',
        )
      }
      await setProviderColumn(await requireOwner(), change.provider, { modelChat: change.value })
      return
    }
    case 'ai_chat_routing_rule':
      await setProviderColumn(await requireOwner(), 'eurouter', { ruleChat: change.value })
      return
    case 'ai_use_eigen_inference':
      await withDbUser(actorUserId, () => setCompanyUseEigenInference(change.value, actorUserId))
      return
    case 'ai_slot_model':
      try {
        await withDbUser(actorUserId, () => setCompanySlotModel(change.slot, change.value, actorUserId))
      } catch (err) {
        if (err instanceof CompanyAiInputError) throw new KernelError('invalid_input', err.message)
        throw err
      }
      return
  }
}

export const agentSettingsPort: SettingsPort = {
  // Exactly the durable engine's model-call wrapping (agent/db-scoped-complete.ts).
  modelFor: (identity) => onCompanyProvider(() => withDbUser(identity, () => describeChatModel(identity))),
  person: async (userId) => {
    const [profile, role] = await Promise.all([getProfile(userId), getUserRole(userId)])
    return { id: userId, name: profile.name || null, email: profile.email || null, role }
  },
  read,
  apply,
}
