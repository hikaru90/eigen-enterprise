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

/**
 * Where an LLM call's text comes from, declared by its caller. `'memory'`: a person's private
 * Memory — thoughts, tasks, projects, notes, check-ins and the questions asked of them. The
 * gateway keeps such a call's cost, tokens, model and timing and never its text: no prompt or
 * answer in server logs, no preview in the AI usage log (activity_call_log.context), no
 * `$ai_input` / `$ai_output_choices` in PostHog's `$ai_generation`.
 */
export type LlmContentOrigin = 'memory'
