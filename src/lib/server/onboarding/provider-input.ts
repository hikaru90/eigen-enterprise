import type { ResolvedLlmConfig } from '$lib/server/llm/types'

export type ProviderInput = {
  provider: 'eurouter' | 'openrouter'
  baseUrl: string
  apiKey: string
  ruleChat: string | null
  ruleEmbedding: string | null
  modelChat: string | null
  modelEmbedding: string | null
}

/**
 * Guided-onboarding credential shape: stricter than Settings (which tolerates partial
 * saves) because this wizard must produce a WORKING provider — EUrouter needs both
 * routing rules, OpenRouter both model ids.
 */
export function parseProviderInput(body: unknown): { config: ResolvedLlmConfig } | { error: string } {
  if (typeof body !== 'object' || body === null) {
    return { error: 'Invalid request body.' }
  }
  const raw = body as Record<string, unknown>
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : ''
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  const ruleChat = typeof raw.ruleChat === 'string' ? raw.ruleChat.trim() : ''
  const ruleEmbedding = typeof raw.ruleEmbedding === 'string' ? raw.ruleEmbedding.trim() : ''
  const modelChat = typeof raw.modelChat === 'string' ? raw.modelChat.trim() : ''
  const modelEmbedding = typeof raw.modelEmbedding === 'string' ? raw.modelEmbedding.trim() : ''

  if (provider !== 'eurouter' && provider !== 'openrouter') {
    return { error: 'Pick a provider to continue.' }
  }
  if (!baseUrl) {
    return { error: 'Base URL is required.' }
  }
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    return { error: 'Base URL must start with http:// or https://' }
  }
  if (!apiKey) {
    return { error: 'API key is required.' }
  }

  if (provider === 'eurouter') {
    if (!ruleChat || !ruleEmbedding) {
      return { error: 'EUrouter needs a chat and an embedding routing rule ID.' }
    }
  } else if (!modelChat || !modelEmbedding) {
    return { error: 'OpenRouter needs a chat and an embedding model.' }
  }

  return {
    config: {
      provider,
      baseUrl: baseUrl.replace(/\/$/, ''),
      apiKey,
      ruleChat: ruleChat || null,
      ruleEmbedding: ruleEmbedding || null,
      modelChat: modelChat || null,
      modelEmbedding: modelEmbedding || null,
    },
  }
}
