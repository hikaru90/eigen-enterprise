import type { ResolvedLlmConfig } from '$lib/server/llm/types'
import { env } from '$lib/server/env/private-env'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import {
  PLATFORM_AI_PROVIDER,
  readPlatformAiConfig,
  type PlatformAiConfig,
} from '$lib/server/llm/platform-ai'

/** This process's platform AI from hosting (PLATFORM_LLM_*), or null. Throws on a partial set. */
export function platformAiFromEnv(): PlatformAiConfig | null {
  return readPlatformAiConfig(env as Record<string, string | undefined>)
}

/** What every model call says on a server that has no eigenInference while the switch is on. */
export const EIGEN_INFERENCE_NOT_CONNECTED =
  'eigenInference is not connected on this server. An owner or admin turns off "Use eigenInference" and adds the company\'s own key under Settings → AI provider → Advanced.'

/**
 * The eigenInference credential (Settings → AI provider, "Use eigenInference" on): the
 * hosting's endpoint and per-company key (`PLATFORM_LLM_*`, contract in platform-ai.ts), for
 * every slot — chat, embeddings, speech to text, text to speech, decisions. Nothing else:
 * since CB1 there is no self-hosted service account (the `LLM_BASE_URL` +
 * `SERVICE_API_KEY_EUROUTER` and `OPENROUTER_BASE_URL` + `SERVICE_API_KEY_OPENROUTER` pairs are
 * gone). Without it every call fails loud with {@link EIGEN_INFERENCE_NOT_CONNECTED}.
 */
export function loadEigenInferenceConfig(): ResolvedLlmConfig {
  const platformAi = platformAiFromEnv()
  if (!platformAi) throw new LlmNotConfiguredError(EIGEN_INFERENCE_NOT_CONNECTED)
  return {
    provider: PLATFORM_AI_PROVIDER,
    eigenInferenceProvider: platformAi.provider,
    baseUrl: platformAi.baseUrl,
    apiKey: platformAi.apiKey,
    ruleChat: null,
    ruleEmbedding: null,
    modelChat: null,
    modelEmbedding: platformAi.modelEmbedding,
  }
}
