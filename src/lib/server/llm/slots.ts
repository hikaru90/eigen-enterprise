import type { LlmProviderKind, ResolvedLlmConfig } from './types'
import { resolveHarnessBillingUserId } from '$lib/server/auth/harness-billing'
import { env } from '$lib/server/env/private-env'
import { loadLlmProviderConfig, resolveActiveProviderLlmConfig } from './byok-credentials'
import { companyAiStore, type CompanyAiSettings } from './company-ai'
import { companyOwnerId } from './company-provider'
import { LlmNotConfiguredError } from './errors'
import { assertPoolModel, providerRoute, recommendedModel, type ModelSlot, type PoolProvider } from './model-pool'
import { PLATFORM_AI_PROVIDER } from './platform-ai'
import { loadEigenInferenceConfig } from './platform-llm'
import { isByokBilling } from './preferences'

/**
 * Slot resolution (CB1): the one place a model call learns where it goes — endpoint, key and
 * model — for its role slot. It resolves for the COMPANY, never for the person who triggered the
 * call: a member's Memory ingest, the owner's chat and a background job all run on the same
 * company settings (`company_ai`, Settings → AI). That is what keeps a member from landing on a
 * path the company never set up (Ony, Contribute 19cf0d97: her ingest resolved her own, empty,
 * settings and ended in the platform EUrouter config).
 *
 * - **eigenInference on:** the hosting's endpoint and per-company key (`PLATFORM_LLM_*`).
 * - **eigenInference off (bring your own key):** the provider saved on the owner's account.
 *
 * The model is the slot's pick from the pool (`model-pool.ts`), or the recommendation of the
 * provider that serves the pool here ({@link SlotTarget.pool}): eigenInference's provider
 * (OpenRouter or Opper, PLATFORM_LLM_PROVIDER), or OpenRouter on the company's own key. A pick
 * that provider does not serve fails loud (ModelNotServedError): never swapped for another.
 * The embedding model is fixed per install: pinned on its first resolution, never changed after.
 */

export type SlotSource = 'eigeninference' | 'byok'

export type SlotTarget = {
  slot: ModelSlot
  source: SlotSource
  /** Endpoint + key (and, for a provider outside the pool's namespace, its own routing). */
  config: ResolvedLlmConfig
  /**
   * The pool model the call sends. null only for a bring-your-own-key provider outside the
   * pool's namespace (EUrouter routing rules, GitHub Copilot, a models.dev provider): its chat
   * and embeddings route by its own saved model or rule.
   */
  model: string | null
  /** Who routes by the pool here (null exactly when model is null). */
  pool: PoolProvider | null
  /** The id the request sends for `model`: the pool provider's route (Opper's EU id, OpenRouter's id). */
  route: string | null
}

/** Providers that route by the pool's model ids (OpenRouter's namespace). */
const POOL_NAMESPACE: ReadonlySet<LlmProviderKind> = new Set([PLATFORM_AI_PROVIDER, 'openrouter'])

/** Slots that only an OpenRouter-namespace endpoint serves (audio, Jev). */
const OPENROUTER_ONLY_SLOTS: ReadonlySet<ModelSlot> = new Set(['stt', 'tts', 'decision'])

export function routesByPoolModel(provider: LlmProviderKind): boolean {
  return POOL_NAMESPACE.has(provider)
}

/** Which pool provider a config routes by: eigenInference's provider, OpenRouter for an OpenRouter key, else null. */
export function poolProviderOf(config: ResolvedLlmConfig): PoolProvider | null {
  if (config.provider === PLATFORM_AI_PROVIDER) {
    if (!config.eigenInferenceProvider) {
      throw new Error('The eigenInference config names no provider (platform-llm.ts must set eigenInferenceProvider).')
    }
    return config.eigenInferenceProvider
  }
  return config.provider === 'openrouter' ? 'openrouter' : null
}

/**
 * The id to send for a per-call chat model (a co-worker's own model) on this target's provider.
 * Outside the pool → ModelNotInPoolError; not served there → ModelNotServedError.
 */
export function slotRoute(target: SlotTarget, model: string): string {
  if (!target.pool) throw new LlmNotConfiguredError(`The ${target.slot} slot on ${target.config.provider} does not route by the model pool.`)
  return providerRoute(target.slot, model, target.pool)
}

export type SlotDeps = {
  readCompanyAi: () => Promise<CompanyAiSettings>
  pinEmbeddingModel: (model: string) => Promise<string>
  /** The eigenInference credential (one key for every slot), or throws LlmNotConfiguredError. */
  eigenInference: () => Promise<ResolvedLlmConfig>
  companyOwnerId: () => Promise<string | null>
  /** The account's active bring-your-own-key provider config (chat, embeddings). */
  byokActive: (accountId: string) => Promise<ResolvedLlmConfig>
  /** The account's saved provider config for one provider. */
  byokProvider: (accountId: string, provider: LlmProviderKind) => Promise<ResolvedLlmConfig>
  /** Benchmark/eval harness tenants run on their operator's account and billing mode. */
  harnessAccount: (callerId: string | null) => string | undefined
  harnessUsesOwnKey: (accountId: string) => Promise<boolean>
}

export const liveSlotDeps: SlotDeps = {
  readCompanyAi: () => companyAiStore().read(),
  pinEmbeddingModel: (model) => companyAiStore().pinEmbeddingModel(model),
  eigenInference: async () => loadEigenInferenceConfig(),
  companyOwnerId: () => companyOwnerId(),
  byokActive: (accountId) => resolveActiveProviderLlmConfig(accountId),
  byokProvider: (accountId, provider) => loadLlmProviderConfig(accountId, provider),
  harnessAccount: (callerId) => (callerId ? resolveHarnessBillingUserId(callerId) : undefined),
  harnessUsesOwnKey: (accountId) => isByokBilling(accountId),
}

/** Where the company's calls go right now: eigenInference or its own key (the Settings → AI switch). */
export async function companySlotSource(callerId: string | null, deps: SlotDeps = liveSlotDeps): Promise<SlotSource> {
  const harness = deps.harnessAccount(callerId)
  if (harness) return (await deps.harnessUsesOwnKey(harness)) ? 'byok' : 'eigeninference'
  return (await deps.readCompanyAi()).useEigenInference ? 'eigeninference' : 'byok'
}

async function byokAccount(callerId: string | null, deps: SlotDeps): Promise<string> {
  const harness = deps.harnessAccount(callerId)
  if (harness) return harness
  const owner = await deps.companyOwnerId()
  if (!owner) {
    throw new LlmNotConfiguredError(
      'The company has no owner yet, so it has no key of its own. Turn on "Use eigenInference" or let the owner add a key under Settings → AI → Advanced.',
    )
  }
  return owner
}

async function slotConfig(
  slot: ModelSlot,
  source: SlotSource,
  callerId: string | null,
  deps: SlotDeps,
): Promise<ResolvedLlmConfig> {
  if (source === 'eigeninference') return deps.eigenInference()
  const audioOrJev = OPENROUTER_ONLY_SLOTS.has(slot)
  const account = await byokAccount(callerId, deps)
  // Speech and Jev run on OpenRouter whatever provider chat uses: the company's OpenRouter key.
  return audioOrJev ? deps.byokProvider(account, 'openrouter') : deps.byokActive(account)
}

/** The pinned embedding model, pinning it on the first resolution (what the install embeds with today, else the pool's pick). */
async function embeddingModel(
  settings: CompanyAiSettings,
  config: ResolvedLlmConfig,
  pool: PoolProvider,
  deps: SlotDeps,
): Promise<string> {
  if (settings.embeddingModel) return assertPoolModel('embedding', settings.embeddingModel)
  // First resolution on this install: keep whatever its vectors were made with until now
  // (the hosting's provisioned model, the key's saved model, the server's env), so no
  // existing vector changes meaning. A model outside the pool fails loud here, once.
  // A model this provider does not serve is never pinned (ModelNotServedError): the install's
  // vectors would be made with a model it cannot call.
  const current = config.modelEmbedding?.trim() || env.LLM_MODEL_EMBEDDING?.trim() || recommendedModel('embedding', pool)
  providerRoute('embedding', current, pool)
  return deps.pinEmbeddingModel(current)
}

/**
 * The (endpoint, key, model) a call for `slot` uses, for the company. `callerId` is the person
 * or principal the call is attributed to; it only matters for benchmark/eval harness tenants,
 * which run on their operator's account. Throws LlmNotConfiguredError when the company's
 * source has no credential, ModelNotInPoolError when a stored model left the pool.
 */
// eigenInference runs on the models we choose for it (the pool's picks for its provider); the
// company's own picks (Settings → AI, shown only on its own key) apply only to its own key.
export async function resolveSlot(
  slot: ModelSlot,
  callerId: string | null,
  deps: SlotDeps = liveSlotDeps,
): Promise<SlotTarget> {
  const settings = await deps.readCompanyAi()
  const source = await companySlotSource(callerId, deps)
  const config = await slotConfig(slot, source, callerId, deps)

  if (!routesByPoolModel(config.provider)) {
    if (OPENROUTER_ONLY_SLOTS.has(slot)) {
      throw new LlmNotConfiguredError(`The ${slot} slot needs an OpenRouter-compatible endpoint; ${config.provider} is not one.`)
    }
    return { slot, source, config, model: null, pool: null, route: null }
  }

  const pool = poolProviderOf(config)!
  const model =
    slot === 'embedding'
      ? await embeddingModel(settings, config, pool, deps)
      : assertPoolModel(slot, (source === 'byok' ? settings.picks[slot] : null) ?? recommendedModel(slot, pool))
  return { slot, source, config, model, pool, route: providerRoute(slot, model, pool) }
}

/**
 * The pool provider the company's models come from right now (Settings → AI lists what it
 * serves): eigenInference's provider while the switch is on, else OpenRouter (the company's own
 * OpenRouter key serves the pool; a provider outside it routes by its own model names).
 */
export async function companyPoolProvider(callerId: string | null, deps: SlotDeps = liveSlotDeps): Promise<PoolProvider> {
  if ((await companySlotSource(callerId, deps)) === 'byok') return 'openrouter'
  return poolProviderOf(await deps.eigenInference())!
}
