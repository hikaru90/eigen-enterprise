import { chatModelOption, type ChatModelOption } from '$lib/coworkers/model-family'
import { chatModels } from '$lib/server/llm/model-pool'
import type { SlotSource } from '$lib/server/llm/slots'

/**
 * The models a co-worker may be given in the forms (wish cd140a7a, 2026-11-28): none on
 * eigenInference, which runs every co-worker on the pool's chat pick and names no model; the
 * pool's chat models on the company's own key. coworkers.create / update refuse a model_id on
 * eigenInference the same way (modules/coworkers/tools.ts).
 */
export function coworkerModelOptions(source: SlotSource): ChatModelOption[] {
  return source === 'eigeninference' ? [] : chatModels().map(chatModelOption)
}

/** The live company's options (Settings → AI decides the source). */
export async function liveCoworkerModelOptions(): Promise<ChatModelOption[]> {
  const { companySlotSource } = await import('$lib/server/llm/slots')
  return coworkerModelOptions(await companySlotSource(null))
}
