/**
 * The model family a co-worker runs on (plan/phase-ai-coworkers.md §1: a different
 * family per seat), read from the pool id's provider namespace — `anthropic/claude-…`
 * is Anthropic. Structure, not meaning: the namespace before the slash names the
 * maker (OpenRouter ids; a leading `~` marks a moving alias). Shared by the
 * server loads and the components.
 */

/** Display names of the namespaces the pool uses; any other namespace shows as written. */
const FAMILY_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  google: 'Google',
  mistralai: 'Mistral',
  openai: 'OpenAI',
  qwen: 'Qwen',
}

export function modelFamily(modelId: string): string {
  const id = modelId.trim().replace(/^~/, '')
  const slash = id.indexOf('/')
  if (slash <= 0) throw new Error(`model id "${modelId}" has no provider namespace (expected maker/model)`)
  const ns = id.slice(0, slash)
  return FAMILY_NAMES[ns] ?? ns
}

/** The model's own name without the namespace: `claude-sonnet-5.5`. */
export function modelName(modelId: string): string {
  const id = modelId.trim().replace(/^~/, '')
  return id.slice(id.indexOf('/') + 1)
}

/** A chat model a co-worker may run on (the pool's chat slot), with its family. */
export type ChatModelOption = { id: string; family: string; name: string; note: string; recommended: boolean }

export function chatModelOption(m: { id: string; note: string; recommended?: boolean }): ChatModelOption {
  return { id: m.id, family: modelFamily(m.id), name: modelName(m.id), note: m.note, recommended: m.recommended === true }
}

/** What a co-worker's model shows as on eigenInference (wish 60bd7be2): the model is not named. */
export const EIGENINFERENCE_LABEL = 'eigenInference'

/** The model a label names, or null when it names none (eigenInference). */
export function shownModel(modelLabel: string): string | null {
  return modelLabel === EIGENINFERENCE_LABEL ? null : modelLabel
}
