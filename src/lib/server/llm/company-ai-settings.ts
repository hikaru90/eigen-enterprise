import { env } from '$lib/server/env/private-env'
import { companyAiStore, type CompanyAiStore } from './company-ai'
import {
  CHOOSABLE_SLOTS,
  isChoosableSlot,
  isPoolModel,
  isServedOn,
  poolFor,
  POOL_PROVIDERS,
  poolProviderLabel,
  recommendedModel,
  type ChoosableSlot,
  type PoolProvider,
} from './model-pool'
import { readPlatformAiConfig } from './platform-ai'

/**
 * Settings → AI (CB1), one service behind the page and the agent's settings.update: the
 * "Use eigenInference" switch, the four choosable slots (a pool model, or the provider's pick) and
 * the install's fixed embedding model. The UI and the registry are both clients of this.
 *
 * The models offered are the ones the company's pool provider serves ({@link companyAiProvider}):
 * eigenInference's provider while the switch is on, OpenRouter on the company's own key (the
 * gateway resolves the same way, slots.ts).
 */

export type SlotChoice = {
  slot: ChoosableSlot
  /** What the company runs on for this slot now. */
  model: string
  /** null = the provider's pick (the company never chose). */
  pick: string | null
  /** The models the provider serves for the slot, its recommendation first. */
  options: Array<{ id: string; note: string; recommended: boolean }>
  /** False when the company's pick is one the provider does not serve: its calls fail until an owner or admin picks another. */
  available: boolean
}

export type CompanyAiView = {
  useEigenInference: boolean
  /** Who serves the company's models now (the options below are what it serves). */
  provider: PoolProvider
  providerLabel: string
  /** This server has the hosting's eigenInference credential (PLATFORM_LLM_*). */
  eigenInferenceAvailable: boolean
  slots: SlotChoice[]
  /** Fixed per install; null until the first embedding pins it (then the pool's pick or what the install already used). */
  embeddingModel: string | null
}

/**
 * The pool provider for the company's settings: eigenInference's provider while the switch is
 * on, else OpenRouter. With the switch on and no eigenInference on this server, the provider
 * protocol v1 meant (OpenRouter) is shown; every call then fails loud anyway (not connected).
 */
export function companyAiProvider(useEigenInference: boolean): PoolProvider {
  if (!useEigenInference) return 'openrouter'
  return readPlatformAiConfig(env as Record<string, string | undefined>)?.provider ?? 'openrouter'
}

export async function readCompanyAiView(store: CompanyAiStore = companyAiStore()): Promise<CompanyAiView> {
  const settings = await store.read()
  const provider = companyAiProvider(settings.useEigenInference)
  return {
    useEigenInference: settings.useEigenInference,
    provider,
    providerLabel: poolProviderLabel(provider),
    eigenInferenceAvailable: readPlatformAiConfig(env as Record<string, string | undefined>) !== null,
    slots: CHOOSABLE_SLOTS.map((slot) => {
      // eigenInference runs on our choice; the company's picks are for its own key (slots.ts).
      const model = (settings.useEigenInference ? null : settings.picks[slot]) ?? recommendedModel(slot, provider)
      return {
        slot,
        model,
        pick: settings.picks[slot],
        options: poolFor(slot, provider).map((m) => ({
          id: m.id,
          note: m.note,
          recommended: Boolean(m.recommendedOn?.includes(provider)),
        })),
        available: isServedOn(slot, model, provider),
      }
    }),
    embeddingModel: settings.embeddingModel,
  }
}

export class CompanyAiInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompanyAiInputError'
  }
}

export async function setCompanyUseEigenInference(
  on: boolean,
  actorUserId: string,
  store: CompanyAiStore = companyAiStore(),
): Promise<void> {
  await store.setUseEigenInference(on, actorUserId)
}

/** Sets a slot to a pool model (stored as chosen: a company that picked a model keeps it if the pool's pick moves). */
export async function setCompanySlotModel(
  slot: string,
  model: string,
  actorUserId: string,
  store: CompanyAiStore = companyAiStore(),
): Promise<void> {
  if (!isChoosableSlot(slot)) {
    throw new CompanyAiInputError(`"${slot}" is not a slot you can choose (chat, stt, tts, decision; embedding is fixed per install).`)
  }
  const served = (provider: PoolProvider) =>
    poolFor(slot, provider)
      .map((m) => m.id)
      .join(', ')
  if (!isPoolModel(slot, model)) {
    throw new CompanyAiInputError(
      `"${model}" is not in the model pool for the ${slot} slot. Choose one of: ${POOL_PROVIDERS.map((p) => `${served(p)} (${poolProviderLabel(p)})`).join('; ')}.`,
    )
  }
  // A pick is for the company's own key (eigenInference ignores it), so it is checked against that pool.
  const provider = companyAiProvider(false)
  if (!isServedOn(slot, model, provider)) {
    throw new CompanyAiInputError(
      `"${model}" is not available on ${poolProviderLabel(provider)} for the ${slot} slot. Choose one of: ${served(provider)}.`,
    )
  }
  await store.setPick(slot, model, actorUserId)
}
