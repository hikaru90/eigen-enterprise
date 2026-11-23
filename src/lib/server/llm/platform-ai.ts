/**
 * eigenInference on a hosted box (plan/phase-company-brain.md §6, CB1): the inference
 * eigenEnterprise rents to the company, through one service-account key per company.
 * ee sets these os secrets from the fleet's desired `platformAi` (ee/src/fleet/agent.ts,
 * PLATFORM_AI_SECRETS); all four or none. A partial set fails loud at start.
 *
 * The contract (what the endpoint must serve, with that one key):
 * - an OpenAI-compatible API that routes by model name, for EVERY model in the pool
 *   (`model-pool.ts`, OpenRouter's namespace): `/chat/completions` (chat slot, tool calls),
 *   `/embeddings` (embedding slot, `dimensions: 1536`), OpenRouter's `/audio/transcriptions`
 *   (JSON `input_audio`, speech-to-text slot), `/audio/speech` (text-to-speech slot), and the
 *   decision slot's model (Jev, `typesafe/jev-1.13`) on OpenRouter's Decisions API beside the
 *   base: `<base without /v1>/alpha/decisions` (llm-decide.ts, CB2);
 * - per-call cost in the response (`usage.cost`), shown per call in Activity.
 *
 * What each secret does since CB1:
 * - `PLATFORM_LLM_BASE_URL` + `PLATFORM_LLM_API_KEY`: the eigenInference credential every
 *   slot runs on while "Use eigenInference" is on.
 * - `PLATFORM_LLM_MODEL_EMBEDDING`: the embedding model the hosting provisioned the install
 *   with; it is pinned as the install's fixed embedding model on the first embedding (it must
 *   be a pool embedding model, or that first embedding fails loud). Once pinned it is not read.
 * - `PLATFORM_LLM_MODEL_CHAT`: no longer read — the company's chat slot decides the chat model
 *   (the pool's pick until an owner or admin picks another in Settings). Still required in the
 *   set so the fleet protocol (v1, four fields) and boxes upgraded from it keep starting.
 *
 * It is its own declared provider kind ({@link PLATFORM_AI_PROVIDER}): what sits behind the URL
 * is the hosting's business and is never inferred from it. Never read as the self-hosted BYOK
 * pair (LLM_BASE_URL + LLM_API_KEY).
 */

/** The provider kind a platform-AI config resolves to (gateway, activity log, analytics). */
export const PLATFORM_AI_PROVIDER = 'platform' as const

export type PlatformAiConfig = {
  baseUrl: string
  apiKey: string
  modelChat: string
  modelEmbedding: string
}

export const PLATFORM_AI_ENV = {
  baseUrl: 'PLATFORM_LLM_BASE_URL',
  apiKey: 'PLATFORM_LLM_API_KEY',
  modelChat: 'PLATFORM_LLM_MODEL_CHAT',
  modelEmbedding: 'PLATFORM_LLM_MODEL_EMBEDDING',
} as const satisfies Record<keyof PlatformAiConfig, string>

/** All set → the config; none → null (no platform AI); some → throws naming the missing ones. */
export function readPlatformAiConfig(env: Record<string, string | undefined>): PlatformAiConfig | null {
  const entries = Object.entries(PLATFORM_AI_ENV) as [keyof PlatformAiConfig, string][]
  const values = entries.map(([k, name]) => [k, name, env[name]?.trim() ?? ''] as const)
  const missing = values.filter(([, , v]) => v === '').map(([, name]) => name)
  if (missing.length === entries.length) return null
  if (missing.length > 0) {
    throw new Error(
      `The platform AI from hosting is only partly configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set (all four PLATFORM_LLM_* or none).`,
    )
  }
  const config = Object.fromEntries(values.map(([k, , v]) => [k, v])) as PlatformAiConfig
  return { ...config, baseUrl: config.baseUrl.replace(/\/$/, '') }
}
