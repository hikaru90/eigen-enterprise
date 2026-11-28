/**
 * The curated model pool (plan/phase-company-brain.md §6, CB1): every model eigenEnterprise
 * may call, by role slot. A slot never holds a model that is not listed here — Settings → AI
 * only offers these, the gateway refuses anything else, and the pool grows only by a commit
 * that names the date the model was vetted.
 *
 * A pool id is the model's canonical name (OpenRouter's namespace, where the pool started). Each
 * entry declares which providers serve it and under which id ({@link PoolModel.routes}), and
 * each provider recommends exactly one model per slot. A company's stored pick is a pool id; the
 * provider's id is only what goes on the wire ({@link providerRoute}).
 *
 * - `openrouter`: eigenInference on OpenRouter, and a company's own OpenRouter key.
 * - `opper`: eigenInference on Opper (owner, 2026-11-27): every route is an EU route; a model
 *   with no EU route is not offered there (Jev, qwen3-asr, Qwen TTS, text-embedding-3-small).
 */

/** The providers that route by the pool (the namespaces a pool entry can name a route in). */
export const POOL_PROVIDERS = ['openrouter', 'opper'] as const
export type PoolProvider = (typeof POOL_PROVIDERS)[number]

const PROVIDER_LABEL: Record<PoolProvider, string> = { openrouter: 'OpenRouter', opper: 'Opper' }

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
  /** The id each provider that serves the model routes it by; a provider not named does not serve it. */
  routes: Partial<Record<PoolProvider, string>>
  /** The providers whose pick for the slot this is (what a company runs on until it chooses). Exactly one per slot per provider. */
  recommendedOn?: readonly PoolProvider[]
  /** False when the upstream model rejects custom `temperature` values (e.g. OpenAI GPT-5 reasoning family). */
  supportsTemperature?: false
  /** Maximum number of tool declarations the upstream model accepts per request (e.g. OpenAI's 128-tool cap). */
  maxTools?: number
  /** Chat models only: reads images and PDFs sent as content parts (llm-client ChatAttachment). */
  readsImages?: true
  /**
   * Chat models only: the providers on which this is THE model that reads images when the
   * company's chat model does not (vision.ts). Exactly one per provider (pinned by the spec).
   */
  visionPickOn?: readonly PoolProvider[]
  /** Text to speech: 'model-default' = send no voice (the model speaks in its own; the app's voice setting names another model's voices). */
  ttsVoice?: 'model-default'
}

export const MODEL_POOL: readonly PoolModel[] = [
  {
    id: '~deepseek/deepseek-flash-latest',
    slot: 'chat',
    routes: { openrouter: '~deepseek/deepseek-flash-latest', opper: 'mistral/deepseek-v4-1-flash-1017' },
    vettedOn: '2026-11-20',
    note: "DeepSeek's newest Flash: the chat model os.cerberusblue.com runs on (owner's pick); cheap, tool calls work. On Opper: DeepSeek V4.1 Flash served by Mistral (EU).",
    recommendedOn: ['openrouter', 'opper'],
  },
  {
    id: 'openai/gpt-5-mini',
    slot: 'chat',
    routes: { openrouter: 'openai/gpt-5-mini', opper: 'azure/gpt-5-mini' },
    vettedOn: '2026-11-20',
    note: 'The hosted platform AI chat model the control plane provisions today.',
    supportsTemperature: false,
    maxTools: 128,
    readsImages: true,
  },
  // AI Co-workers (plan/phase-ai-coworkers.md §5): different model families, so co-workers in
  // different seats do not all think alike. Pinned ids (no moving `~…-latest` aliases). Vetted on
  // OpenRouter's model list: chat, `tools` in supported_parameters, live tool-capable endpoints.
  // Claude Sonnet 5.5 was removed 2026-11-26 (owner): one co-worker turn cost up to $1, 50–100×
  // a DeepSeek Flash turn. No Sonnet model is offered in any slot.
  {
    id: 'google/gemini-3.8-flash',
    slot: 'chat',
    routes: { openrouter: 'google/gemini-3.8-flash', opper: 'vertexai/gemini-3.8-flash-eu' },
    vettedOn: '2026-11-23',
    note: 'Google family for co-workers: fast and mid-priced, 1M context; reads images, PDFs, audio and video.',
    readsImages: true,
    visionPickOn: ['openrouter', 'opper'],
  },
  {
    id: 'qwen/qwen3.8-flash',
    slot: 'chat',
    routes: { openrouter: 'qwen/qwen3.8-flash', opper: 'alibaba:eu/qwen3.8-flash' },
    vettedOn: '2026-11-23',
    note: 'Qwen family for co-workers: the cheap seat (about $0.15 / $0.47 per million tokens), tool calls on Alibaba endpoints.',
  },
  {
    id: 'mistralai/mistral-large-4-0',
    slot: 'chat',
    routes: { openrouter: 'mistralai/mistral-large-4-0', opper: 'mistral:eu/mistral-large-4' },
    vettedOn: '2026-11-23',
    note: 'Mistral family for co-workers: a European model, tool calls on Mistral endpoints.',
  },
  {
    id: 'qwen/qwen3-asr-1.7b',
    slot: 'stt',
    routes: { openrouter: 'qwen/qwen3-asr-1.7b' },
    vettedOn: '2026-11-19',
    note: 'Every transcript in the app (owner, on price: about $0.03 per hour of audio). Weaker on names.',
    recommendedOn: ['openrouter'],
  },
  {
    id: 'qwen/qwen-audio-3.0-tts-flash',
    slot: 'tts',
    routes: { openrouter: 'qwen/qwen-audio-3.0-tts-flash' },
    vettedOn: '2026-11-11',
    note: "The assistant's voice; live OpenRouter endpoint (Alibaba), voices loongjohn / longanhuan_v3.6.",
    recommendedOn: ['openrouter'],
  },
  {
    id: 'typesafe/jev-1.13',
    slot: 'decision',
    routes: { openrouter: 'typesafe/jev-1.13' },
    vettedOn: '2026-11-20',
    note: 'Jev: answers from a closed set (owner maxim: decision shape picks the engine). Called from CB2 on.',
    recommendedOn: ['openrouter'],
  },
  // eigenInference on Opper (owner, 2026-11-27): speech on Mistral Voxtral and decisions on
  // clef-flash, all on EU routes; vetted live against Opper's API on that date.
  {
    id: 'mistral/voxtral-mini-transcribe-3-0',
    slot: 'stt',
    routes: { opper: 'mistral/voxtral-mini-transcribe-3-0' },
    vettedOn: '2026-11-27',
    note: 'Mistral Voxtral Mini Transcribe (EU): every transcript on Opper; checked on a German recording.',
    recommendedOn: ['opper'],
  },
  {
    id: 'mistral/voxtral-mini-tts-3-0',
    slot: 'tts',
    routes: { opper: 'mistral/voxtral-mini-tts-3-0' },
    vettedOn: '2026-11-27',
    note: "Mistral Voxtral Mini TTS (EU): the assistant's voice on Opper, in the model's default voice.",
    recommendedOn: ['opper'],
    ttsVoice: 'model-default',
  },
  {
    id: 'ovhcloud/clef-flash',
    slot: 'decision',
    routes: { opper: 'ovhcloud/clef-flash' },
    vettedOn: '2026-11-27',
    note: "clef-flash on OVHcloud (FR): Opper's closed-set decision model (choice, probabilities, confidence); Jev on Opper is US-only.",
    recommendedOn: ['opper'],
  },
  {
    id: 'qwen/qwen3-embedding-8b',
    slot: 'embedding',
    routes: { openrouter: 'qwen/qwen3-embedding-8b', opper: 'ovhcloud/Qwen3-Embedding-8B' },
    vettedOn: '2026-11-17',
    note: 'Hosted companies embed with it (owner); Matryoshka, shortened to 1536 dimensions. On Opper: OVHcloud (FR), 1536 dimensions, the same model (vetted 2026-11-27).',
    recommendedOn: ['openrouter', 'opper'],
  },
  {
    id: 'openai/text-embedding-3-small',
    slot: 'embedding',
    routes: { openrouter: 'openai/text-embedding-3-small' },
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
      `"${model}" is not in the model pool for the ${slot} slot. A slot only holds a model we vetted: ${MODEL_POOL.filter(
        (m) => m.slot === slot,
      )
        .map((m) => m.id)
        .join(', ')}.`,
    )
    this.name = 'ModelNotInPoolError'
    this.slot = slot
    this.model = model
  }
}

/** A pool model the company's provider does not serve: never swapped for another, the owner picks. */
export class ModelNotServedError extends Error {
  readonly slot: ModelSlot
  readonly model: string
  readonly provider: PoolProvider

  constructor(slot: ModelSlot, model: string, provider: PoolProvider) {
    const others = poolFor(slot, provider).map((m) => m.id)
    const how =
      slot === 'embedding'
        ? 'The embedding model is fixed per install: this install cannot run on it here.'
        : `An owner or admin picks another model in Settings → AI (${others.join(', ')}).`
    super(`"${model}" is not available on ${PROVIDER_LABEL[provider]} for the ${slot} slot. ${how}`)
    this.name = 'ModelNotServedError'
    this.slot = slot
    this.model = model
    this.provider = provider
  }
}

export function isPoolProvider(value: string): value is PoolProvider {
  return (POOL_PROVIDERS as readonly string[]).includes(value)
}

export function poolProviderLabel(provider: PoolProvider): string {
  return PROVIDER_LABEL[provider]
}

export function isModelSlot(value: string): value is ModelSlot {
  return (MODEL_SLOTS as readonly string[]).includes(value)
}

export function isChoosableSlot(value: string): value is ChoosableSlot {
  return (CHOOSABLE_SLOTS as readonly string[]).includes(value)
}

/** The models a provider serves for one slot, its recommendation first. */
export function poolFor(slot: ModelSlot, provider: PoolProvider): PoolModel[] {
  return MODEL_POOL.filter((m) => m.slot === slot && m.routes[provider] !== undefined).sort(
    (a, b) => Number(Boolean(b.recommendedOn?.includes(provider))) - Number(Boolean(a.recommendedOn?.includes(provider))),
  )
}

/**
 * The chat models, recommendation first. Every provider serves every chat model with the same
 * recommendation (pinned by model-pool.spec.ts), so co-workers and the agent pick from one list.
 */
export function chatModels(): Array<{ id: string; note: string; recommended: boolean }> {
  return poolFor('chat', 'openrouter').map((m) => ({ id: m.id, note: m.note, recommended: Boolean(m.recommendedOn?.includes('openrouter')) }))
}

export function isPoolModel(slot: ModelSlot, model: string): boolean {
  return MODEL_POOL.some((m) => m.slot === slot && m.id === model)
}

/** Returns the model when it is in the pool for the slot; throws ModelNotInPoolError otherwise. */
export function assertPoolModel(slot: ModelSlot, model: string): string {
  if (!isPoolModel(slot, model)) throw new ModelNotInPoolError(slot, model)
  return model
}

export function isServedOn(slot: ModelSlot, model: string, provider: PoolProvider): boolean {
  return MODEL_POOL.some((m) => m.slot === slot && m.id === model && m.routes[provider] !== undefined)
}

/**
 * The id `provider` routes a pool model by (what a request sends). Throws ModelNotInPoolError
 * outside the pool, ModelNotServedError when the provider does not serve it.
 */
export function providerRoute(slot: ModelSlot, model: string, provider: PoolProvider): string {
  const entry = MODEL_POOL.find((m) => m.slot === slot && m.id === model)
  if (!entry) throw new ModelNotInPoolError(slot, model)
  const route = entry.routes[provider]
  if (route === undefined) throw new ModelNotServedError(slot, model, provider)
  return route
}

/** A provider's pick for a slot (the model it recommends). */
export function recommendedModel(slot: ModelSlot, provider: PoolProvider): string {
  const picks = MODEL_POOL.filter((m) => m.slot === slot && m.recommendedOn?.includes(provider))
  if (picks.length !== 1) {
    throw new Error(
      `The model pool must recommend exactly one model for the ${slot} slot on ${PROVIDER_LABEL[provider]} (found ${picks.length}).`,
    )
  }
  const pick = picks[0]!
  if (pick.routes[provider] === undefined) {
    throw new Error(`The model pool recommends ${pick.id} for the ${slot} slot on ${PROVIDER_LABEL[provider]}, which does not serve it.`)
  }
  return pick.id
}

/** Whether a model accepts a `temperature` parameter in chat completions (true unless declared false in the pool). */
export function modelSupportsTemperature(modelId: string): boolean {
  const entry = MODEL_POOL.find((m) => m.id === modelId)
  return entry?.supportsTemperature !== false
}

/** Maximum number of tools a model accepts per request, or null when the pool declares no cap. */
export function modelMaxTools(modelId: string): number | null {
  const entry = MODEL_POOL.find((m) => m.id === modelId)
  return entry?.maxTools ?? null
}

/** Whether a text-to-speech call sends the app's voice for this model (false: the model's default voice). */
export function ttsSendsVoice(modelId: string): boolean {
  return MODEL_POOL.find((m) => m.id === modelId)?.ttsVoice !== 'model-default'
}

/**
 * The pool chat model that reads an image or PDF for a company running `chatModel` on `provider`
 * (vision.ts): the chat model itself when it reads images and the provider serves it, else the
 * provider's vision pick. Never a model outside the pool or one the provider does not serve.
 */
export function visionModel(chatModel: string, provider: PoolProvider): string {
  const own = MODEL_POOL.find((m) => m.slot === 'chat' && m.id === chatModel)
  if (own?.readsImages && own.routes[provider] !== undefined) return own.id
  const picks = MODEL_POOL.filter((m) => m.slot === 'chat' && m.visionPickOn?.includes(provider))
  if (picks.length !== 1) {
    throw new Error(`The model pool must name exactly one vision pick on ${PROVIDER_LABEL[provider]} (found ${picks.length}).`)
  }
  const pick = picks[0]!
  if (!pick.readsImages || pick.routes[provider] === undefined) {
    throw new Error(`The model pool's vision pick ${pick.id} must read images and be served on ${PROVIDER_LABEL[provider]}.`)
  }
  return pick.id
}
