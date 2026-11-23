/**
 * The curated model pool (plan/phase-company-brain.md §6, CB1): every model eigenEnterprise
 * may call, by role slot. A slot never holds a model that is not listed here — Settings → AI
 * only offers these, the gateway refuses anything else, and the pool grows only by a commit
 * that names the date the model was vetted.
 *
 * Ids are OpenRouter's namespace: eigenInference (the hosting's endpoint) and a company's own
 * OpenRouter key both route by these names.
 */

/** chat = the LLM that writes; stt/tts = speech; decision = Jev (closed-set answers, CB2); embedding = vectors. */
export const MODEL_SLOTS = ['chat', 'stt', 'tts', 'decision', 'embedding'] as const
export type ModelSlot = (typeof MODEL_SLOTS)[number]

/** The slots a company picks from a dropdown. Embedding is fixed per install (changing it means re-indexing). */
export const CHOOSABLE_SLOTS = ['chat', 'stt', 'tts', 'decision'] as const satisfies readonly ModelSlot[]
export type ChoosableSlot = (typeof CHOOSABLE_SLOTS)[number]

export type PoolModel = {
  id: string
  slot: ModelSlot
  /** ISO date the model was vetted for this slot. */
  vettedOn: string
  /** Why it is in the pool, in a line. */
  note: string
  /** The pool's pick for the slot: what a company runs on until it chooses. Exactly one per slot. */
  recommended?: true
}

export const MODEL_POOL: readonly PoolModel[] = [
  {
    id: '~deepseek/deepseek-flash-latest',
    slot: 'chat',
    vettedOn: '2026-11-20',
    note: "DeepSeek's newest Flash: the chat model os.cerberusblue.com runs on (owner's pick); cheap, tool calls work.",
    recommended: true,
  },
  {
    id: 'openai/gpt-5-mini',
    slot: 'chat',
    vettedOn: '2026-11-20',
    note: 'The hosted platform AI chat model the control plane provisions today.',
  },
  // AI Co-workers (plan/phase-ai-coworkers.md §5): different model families, so co-workers in
  // different seats do not all think alike. Pinned ids (no moving `~…-latest` aliases). Vetted on
  // OpenRouter's model list: chat, `tools` in supported_parameters, live tool-capable endpoints.
  {
    id: 'anthropic/claude-sonnet-5.5',
    slot: 'chat',
    vettedOn: '2026-11-23',
    note: 'Anthropic family for co-workers: strong at long instructions and careful tool use; reads images and PDFs.',
  },
  {
    id: 'google/gemini-3.8-flash',
    slot: 'chat',
    vettedOn: '2026-11-23',
    note: 'Google family for co-workers: fast and mid-priced, 1M context; reads images, PDFs, audio and video.',
  },
  {
    id: 'qwen/qwen3.8-flash',
    slot: 'chat',
    vettedOn: '2026-11-23',
    note: 'Qwen family for co-workers: the cheap seat (about $0.15 / $0.47 per million tokens), tool calls on Alibaba endpoints.',
  },
  {
    id: 'mistralai/mistral-large-4-0',
    slot: 'chat',
    vettedOn: '2026-11-23',
    note: 'Mistral family for co-workers: a European model, tool calls on Mistral endpoints.',
  },
  {
    id: 'qwen/qwen3-asr-1.7b',
    slot: 'stt',
    vettedOn: '2026-11-19',
    note: 'Every transcript in the app (owner, on price: about $0.03 per hour of audio). Weaker on names.',
    recommended: true,
  },
  {
    id: 'qwen/qwen-audio-3.0-tts-flash',
    slot: 'tts',
    vettedOn: '2026-11-11',
    note: "The assistant's voice; live OpenRouter endpoint (Alibaba), voices loongjohn / longanhuan_v3.6.",
    recommended: true,
  },
  {
    id: 'typesafe/jev-1.13',
    slot: 'decision',
    vettedOn: '2026-11-20',
    note: 'Jev: answers from a closed set (owner maxim: decision shape picks the engine). Called from CB2 on.',
    recommended: true,
  },
  {
    id: 'qwen/qwen3-embedding-8b',
    slot: 'embedding',
    vettedOn: '2026-11-17',
    note: 'Hosted companies embed with it (owner); Matryoshka, shortened to 1536 dimensions.',
    recommended: true,
  },
  {
    id: 'openai/text-embedding-3-small',
    slot: 'embedding',
    vettedOn: '2026-11-20',
    note: '1536 dimensions natively; for installs whose vectors were made with it.',
  },
]

/** A model id that is not in the pool for the slot it was asked for. */
export class ModelNotInPoolError extends Error {
  readonly slot: ModelSlot
  readonly model: string

  constructor(slot: ModelSlot, model: string) {
    super(
      `"${model}" is not in the model pool for the ${slot} slot. A slot only holds a model we vetted: ${poolFor(slot)
        .map((m) => m.id)
        .join(', ')}.`,
    )
    this.name = 'ModelNotInPoolError'
    this.slot = slot
    this.model = model
  }
}

export function isModelSlot(value: string): value is ModelSlot {
  return (MODEL_SLOTS as readonly string[]).includes(value)
}

export function isChoosableSlot(value: string): value is ChoosableSlot {
  return (CHOOSABLE_SLOTS as readonly string[]).includes(value)
}

/** The pool's models for one slot, recommended first. */
export function poolFor(slot: ModelSlot): PoolModel[] {
  return MODEL_POOL.filter((m) => m.slot === slot).sort(
    (a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)),
  )
}

export function isPoolModel(slot: ModelSlot, model: string): boolean {
  return MODEL_POOL.some((m) => m.slot === slot && m.id === model)
}

/** Returns the model when it is in the pool for the slot; throws ModelNotInPoolError otherwise. */
export function assertPoolModel(slot: ModelSlot, model: string): string {
  if (!isPoolModel(slot, model)) throw new ModelNotInPoolError(slot, model)
  return model
}

/** The pool's pick for a slot (the model marked recommended). */
export function recommendedModel(slot: ModelSlot): string {
  const picks = MODEL_POOL.filter((m) => m.slot === slot && m.recommended)
  if (picks.length !== 1) {
    throw new Error(`The model pool must recommend exactly one model for the ${slot} slot (found ${picks.length}).`)
  }
  return picks[0]!.id
}
