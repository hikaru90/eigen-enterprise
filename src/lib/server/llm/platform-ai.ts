/**
 * eigenInference on a hosted box (plan/phase-company-brain.md §6, CB1): the inference
 * eigenEnterprise rents to the company, through one service-account key per company.
 * ee sets these os secrets from the fleet's desired `platformAi` (ee/src/fleet/agent.ts,
 * PLATFORM_AI_SECRETS); all four or none. A partial set fails loud at start.
 *
 * Who serves it is `PLATFORM_LLM_PROVIDER` ({@link PLATFORM_AI_PROVIDERS}, fleet feature
 * `platformAiProvider`). Absent = 'openrouter': that is the fleet protocol's v1 meaning, and a box
 * upgrades (and reads this) before its ee agent writes the provider. Any other value fails loud.
 *
 * The contract per provider (what the endpoint must serve, with that one key):
 * - **openrouter:** an OpenAI-compatible API that routes by the pool's OpenRouter ids
 *   (`model-pool.ts` routes.openrouter): `/chat/completions` (chat, tool calls), `/embeddings`
 *   (`dimensions: 1536`), `/audio/transcriptions` (JSON `input_audio`), `/audio/speech`, and the
 *   decision slot's model (Jev) on OpenRouter's Decisions API beside the base:
 *   `<base without /v1>/alpha/decisions` (llm-decide.ts, CB2). Cost: `usage.cost`.
 * - **opper:** the base is Opper's OpenAI-compatible `…/v3/compat`, routing by the pool's Opper
 *   ids (routes.opper, every one an EU route): `/chat/completions`, `/embeddings`, decisions at
 *   `<base>/v1/systemone` (the Decisions body unchanged), and speech beside the compat API at
 *   `<origin>/v3/audio/transcriptions` and `/v3/audio/speech` (JSON in, JSON out; stt-tts in
 *   llm-client.ts). Cost: `usage.cost`, else the `x-opper-cost` header (embeddings, decisions).
 * Per-call cost is always provider-reported, shown per call in Activity.
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

import type { PoolProvider } from './model-pool'

/** The provider kind a platform-AI config resolves to (gateway, activity log, analytics). */
export const PLATFORM_AI_PROVIDER = 'platform' as const

/** Who serves eigenInference (the fleet protocol's PLATFORM_AI_PROVIDERS, ee/src/fleet/protocol.ts). */
export const PLATFORM_AI_PROVIDERS = ['openrouter', 'opper'] as const satisfies readonly PoolProvider[]
export type PlatformAiProviderName = (typeof PLATFORM_AI_PROVIDERS)[number]

/** The os secret naming the provider; absent = 'openrouter' (protocol v1). */
export const PLATFORM_AI_PROVIDER_ENV = 'PLATFORM_LLM_PROVIDER' as const

type PlatformAiSecrets = {
  baseUrl: string
  apiKey: string
  modelChat: string
  modelEmbedding: string
}

export type PlatformAiConfig = PlatformAiSecrets & { provider: PlatformAiProviderName }

function isPlatformAiProvider(value: string): value is PlatformAiProviderName {
  return (PLATFORM_AI_PROVIDERS as readonly string[]).includes(value)
}

function readProvider(raw: string | undefined): PlatformAiProviderName {
  const value = raw?.trim() ?? ''
  if (value === '') return 'openrouter'
  if (!isPlatformAiProvider(value)) {
    throw new Error(
      `${PLATFORM_AI_PROVIDER_ENV} "${value}" is not a provider eigenInference knows (${PLATFORM_AI_PROVIDERS.join(', ')}).`,
    )
  }
  return value
}

export const PLATFORM_AI_ENV = {
  baseUrl: 'PLATFORM_LLM_BASE_URL',
  apiKey: 'PLATFORM_LLM_API_KEY',
  modelChat: 'PLATFORM_LLM_MODEL_CHAT',
  modelEmbedding: 'PLATFORM_LLM_MODEL_EMBEDDING',
} as const satisfies Record<keyof PlatformAiSecrets, string>

/** All set → the config; none → null (no platform AI); some → throws naming the missing ones. */
export function readPlatformAiConfig(env: Record<string, string | undefined>): PlatformAiConfig | null {
  const entries = Object.entries(PLATFORM_AI_ENV) as [keyof PlatformAiSecrets, string][]
  const values = entries.map(([k, name]) => [k, name, env[name]?.trim() ?? ''] as const)
  const missing = values.filter(([, , v]) => v === '').map(([, name]) => name)
  if (missing.length === entries.length) return null
  if (missing.length > 0) {
    throw new Error(
      `The platform AI from hosting is only partly configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set (all four PLATFORM_LLM_* or none).`,
    )
  }
  const config = Object.fromEntries(values.map(([k, , v]) => [k, v])) as PlatformAiSecrets
  return { ...config, baseUrl: config.baseUrl.replace(/\/$/, ''), provider: readProvider(env[PLATFORM_AI_PROVIDER_ENV]) }
}
