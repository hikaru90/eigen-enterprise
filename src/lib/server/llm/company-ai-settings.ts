import { env } from '$lib/server/env/private-env'
import { companyAiStore, type CompanyAiStore } from './company-ai'
import {
  CHOOSABLE_SLOTS,
  isChoosableSlot,
  isPoolModel,
  poolFor,
  recommendedModel,
  type ChoosableSlot,
} from './model-pool'
import { readPlatformAiConfig } from './platform-ai'

/**
 * Settings → AI (CB1), one service behind the page and the agent's settings.update: the
 * "Use eigenInference" switch, the four choosable slots (a pool model, or the pool's pick) and
 * the install's fixed embedding model. The UI and the registry are both clients of this.
 */

export type SlotChoice = {
  slot: ChoosableSlot
  /** What the company runs on for this slot now. */
  model: string
  /** null = the pool's pick (the company never chose). */
  pick: string | null
  options: Array<{ id: string; note: string; recommended: boolean }>
}

export type CompanyAiView = {
  useEigenInference: boolean
  /** This server has the hosting's eigenInference credential (PLATFORM_LLM_*). */
  eigenInferenceAvailable: boolean
  slots: SlotChoice[]
  /** Fixed per install; null until the first embedding pins it (then the pool's pick or what the install already used). */
  embeddingModel: string | null
}

export async function readCompanyAiView(store: CompanyAiStore = companyAiStore()): Promise<CompanyAiView> {
  const settings = await store.read()
  return {
    useEigenInference: settings.useEigenInference,
    eigenInferenceAvailable: readPlatformAiConfig(env as Record<string, string | undefined>) !== null,
    slots: CHOOSABLE_SLOTS.map((slot) => ({
      slot,
      model: settings.picks[slot] ?? recommendedModel(slot),
      pick: settings.picks[slot],
      options: poolFor(slot).map((m) => ({ id: m.id, note: m.note, recommended: Boolean(m.recommended) })),
    })),
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
  if (!isPoolModel(slot, model)) {
    throw new CompanyAiInputError(
      `"${model}" is not in the model pool for the ${slot} slot. Choose one of: ${poolFor(slot)
        .map((m) => m.id)
        .join(', ')}.`,
    )
  }
  await store.setPick(slot, model, actorUserId)
}
