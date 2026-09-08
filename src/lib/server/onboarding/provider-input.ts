import { getProviderCatalog } from '$lib/server/llm/catalog'
import type { ResolvedLlmConfig } from '$lib/server/llm/types'

export type ProviderInput = {
  provider: string
  baseUrl: string
  apiKey: string
  ruleChat: string | null
  ruleEmbedding: string | null
  modelChat: string | null
  modelEmbedding: string | null
}

/**
 * Guided-onboarding credential shape. Strictness comes from the catalog entry:
 * EUrouter needs both routing rules; embedding-capable providers need an embedding
 * model (memory depends on embeddings); providers without embeddings (Copilot) don't.
 * GitHub Copilot never goes through this path — it uses the sign-in flow endpoints.
 */
export async function parseProviderInput(
  body: unknown,
): Promise<{ config: ResolvedLlmConfig } | { error: string }> {
  if (typeof body !== 'object' || body === null) {
    return { error: 'Invalid request body.' }
  }
  const raw = body as Record<string, unknown>
  const provider = typeof raw.provider === 'string' ? raw.provider.trim().toLowerCase() : ''
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : ''
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  const ruleChat = typeof raw.ruleChat === 'string' ? raw.ruleChat.trim() : ''
  const ruleEmbedding = typeof raw.ruleEmbedding === 'string' ? raw.ruleEmbedding.trim() : ''
  const modelChat = typeof raw.modelChat === 'string' ? raw.modelChat.trim() : ''
  const modelEmbedding = typeof raw.modelEmbedding === 'string' ? raw.modelEmbedding.trim() : ''

  if (!provider) {
    return { error: 'Pick a provider to continue.' }
  }
  if (provider === 'github_copilot') {
    return { error: 'GitHub Copilot connects through the sign-in flow.' }
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
    return {
      config: {
        provider,
        baseUrl: baseUrl.replace(/\/$/, ''),
        apiKey,
        ruleChat,
        ruleEmbedding,
        modelChat: modelChat || null,
        modelEmbedding: modelEmbedding || null,
      },
    }
  }

  let supportsEmbeddings = true
  try {
    const { providers } = await getProviderCatalog()
    const entry = providers.find((p) => p.id === provider)
    supportsEmbeddings = entry ? entry.embeddingModels.length > 0 : true
  } catch {
    // Catalog unreachable: keep the permissive default and let the connection test speak.
  }

  if (!modelChat) {
    return { error: 'A chat model is required.' }
  }
  if (supportsEmbeddings && !modelEmbedding) {
    return { error: 'An embedding model is required — memory features depend on it.' }
  }

  return {
    config: {
      provider,
      baseUrl: baseUrl.replace(/\/$/, ''),
      apiKey,
      ruleChat: ruleChat || null,
      ruleEmbedding: ruleEmbedding || null,
      modelChat,
      modelEmbedding: modelEmbedding || null,
    },
  }
}
