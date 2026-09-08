/**
 * Provider id as stored per-user (llm_provider_config.provider). Known ids today:
 * 'eurouter', 'openrouter', 'github_copilot', plus any models.dev catalog id —
 * the column is free-form text, so new providers never need migrations.
 */
export type LlmProviderKind = string

export type ResolvedLlmConfig = {
  provider: LlmProviderKind
  baseUrl: string
  apiKey: string
  ruleChat: string | null
  ruleEmbedding: string | null
  modelChat: string | null
  modelEmbedding: string | null
}
