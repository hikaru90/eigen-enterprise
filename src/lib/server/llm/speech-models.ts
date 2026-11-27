import { env } from '$lib/server/env/private-env'
import type { SpeechFeature, SpeechModelStatus } from '$lib/voice/dictation-readiness'
import { poolFor } from './model-pool'
import { readPlatformAiConfig } from './platform-ai'

export type { SpeechFeature, SpeechModelStatus } from '$lib/voice/dictation-readiness'

/**
 * Whether the speech models still have live endpoints on OpenRouter. A model id can stay
 * valid while every provider behind it is gone; then each call fails (2026-11-11: the STT
 * model had none, and every dictation clip failed). OpenRouter's endpoint list is public
 * (`GET <base>/models/<id>/endpoints`, no key), so the check needs no credentials and sends
 * nothing about the company.
 */
export type SpeechModel = { feature: SpeechFeature; model: string }

/**
 * dictation = speech to text (`stt-client.ts`); voice = the assistant speaking (`tts-client.ts`).
 * The company's picks (Settings → AI), or with none given every speech model OpenRouter serves
 * in the pool (the boot check: a pool model whose endpoints are gone shows on deploy). Opper's
 * speech models are not in this check: the endpoint list is OpenRouter's catalog.
 */
export function speechModels(picks?: { stt: string; tts: string }): SpeechModel[] {
  if (picks) {
    return [
      { feature: 'dictation', model: picks.stt },
      { feature: 'voice', model: picks.tts },
    ]
  }
  return [
    ...poolFor('stt', 'openrouter').map((m) => ({ feature: 'dictation' as const, model: m.id })),
    ...poolFor('tts', 'openrouter').map((m) => ({ feature: 'voice' as const, model: m.id })),
  ]
}

const CACHE_MS = 10 * 60 * 1000
const TIMEOUT_MS = 5000
let cached: { at: number; key: string; statuses: SpeechModelStatus[] } | null = null

export function resetSpeechModelCheckCache(): void {
  cached = null
}

type FetchFn = (url: string, init: { signal: AbortSignal }) => Promise<Response>

async function checkOne(fetchFn: FetchFn, baseUrl: string, m: SpeechModel): Promise<SpeechModelStatus> {
  try {
    const res = await fetchFn(`${baseUrl}/models/${m.model}/endpoints`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return { ...m, error: `OpenRouter answered ${res.status}` }
    const body = (await res.json()) as { data?: { endpoints?: unknown } }
    const endpoints = body?.data?.endpoints
    if (!Array.isArray(endpoints)) return { ...m, error: 'unexpected answer from OpenRouter (no endpoints list)' }
    const providers = endpoints.map((e) => String((e as { provider_name?: unknown }).provider_name ?? 'unknown'))
    return { ...m, endpoints: endpoints.length, providers }
  } catch (err) {
    return { ...m, error: err instanceof Error ? err.message : String(err) }
  }
}

/** OpenRouter's public API: the pool's namespace, whose model endpoint lists need no key. */
export const OPENROUTER_PUBLIC_API = 'https://openrouter.ai/api/v1'

/**
 * Where the speech models are checked: the eigenInference endpoint on a hosted box whose
 * eigenInference is OpenRouter (where its speech runs), else OpenRouter's public catalog (a
 * company's own OpenRouter key serves the same pool ids; an Opper base has no such list). No env
 * of its own: `OPENROUTER_BASE_URL` is not read here since CB1.
 */
export function speechEndpointBaseUrl(): string {
  const platformAi = readPlatformAiConfig(env as Record<string, string | undefined>)
  return platformAi?.provider === 'openrouter' ? platformAi.baseUrl : OPENROUTER_PUBLIC_API
}

export async function checkSpeechModelEndpoints(
  opts: { fetchFn?: FetchFn; baseUrl?: string; models?: SpeechModel[] } = {},
): Promise<SpeechModelStatus[]> {
  const models = opts.models ?? speechModels()
  const baseUrl = (opts.baseUrl ?? speechEndpointBaseUrl()).trim().replace(/\/$/, '')

  const key = `${baseUrl}|${models.map((m) => m.model).join(',')}`
  if (cached && cached.key === key && Date.now() - cached.at < CACHE_MS) return cached.statuses

  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init))
  const statuses = await Promise.all(models.map((m) => checkOne(fetchFn, baseUrl, m)))
  // a failed lookup is not cached: the next page or boot asks again
  if (statuses.every((s) => !('error' in s))) cached = { at: Date.now(), key, statuses }
  return statuses
}

/** One line per model that will fail or could not be checked (for the server log). */
export function speechModelProblems(statuses: readonly SpeechModelStatus[]): string[] {
  return statuses.flatMap((s) => {
    if ('error' in s) return [`${s.feature} model ${s.model} could not be checked: ${s.error}`]
    if (s.endpoints === 0) return [`${s.feature} model ${s.model} has no endpoints on OpenRouter — every call will fail`]
    return []
  })
}

/**
 * At server start: every speech model without endpoints (or that could not be checked) is
 * logged as an error, so a dead model shows on deploy instead of on the first recording.
 * Never throws and never blocks boot (the caller does not await it).
 */
export async function reportSpeechModelsAtStartup(
  log: Pick<Console, 'error'> = console,
  check: () => Promise<SpeechModelStatus[]> = () => checkSpeechModelEndpoints(),
): Promise<void> {
  for (const problem of speechModelProblems(await check())) log.error(`[speech] ${problem}`)
}
