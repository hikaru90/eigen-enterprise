/**
 * The platform AI from hosting: a hosted box runs on inference eigenEnterprise provides.
 * ee sets these os secrets from the fleet's desired `platformAi` (ee/src/fleet/agent.ts,
 * PLATFORM_AI_SECRETS); all four or none. A partial set fails loud at start.
 *
 * An OpenAI-compatible endpoint that routes by model name, with a per-company key. It is
 * its own declared provider kind ({@link PLATFORM_AI_PROVIDER}): what sits behind the URL is
 * the hosting's business and is never inferred from it. The contract includes OpenRouter's
 * `/audio/transcriptions` (JSON `input_audio`): speech on platform credits runs here too. It is the gateway's platform path
 * (billing mode `platform_credits`, the default); a BYOK choice in Settings overrides it.
 * Never read as the self-hosted BYOK pair (LLM_BASE_URL + LLM_API_KEY).
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
