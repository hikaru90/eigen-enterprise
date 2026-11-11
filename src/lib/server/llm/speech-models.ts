import type { SpeechFeature, SpeechModelStatus } from '$lib/voice/dictation-readiness'
import { env } from '$lib/server/env/private-env'
import { STT_MODEL } from './stt-client'
import { ttsModelId } from './tts-client'

export type { SpeechFeature, SpeechModelStatus } from '$lib/voice/dictation-readiness'

/**
 * Whether the speech models still have live endpoints on OpenRouter. A model id can stay
 * valid while every provider behind it is gone; then each call fails (2026-11-11: the STT
 * model had none, and every dictation clip failed). OpenRouter's endpoint list is public
 * (`GET <base>/models/<id>/endpoints`, no key), so the check needs no credentials and sends
 * nothing about the company.
 */
export type SpeechModel = { feature: SpeechFeature; model: string }

/** dictation = speech to text (`stt-client.ts`); voice = the assistant speaking (`tts-client.ts`). */
export function speechModels(): SpeechModel[] {
  return [
    { feature: 'dictation', model: STT_MODEL },
    { feature: 'voice', model: ttsModelId() },
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

export async function checkSpeechModelEndpoints(
  opts: { fetchFn?: FetchFn; baseUrl?: string | undefined; models?: SpeechModel[] } = {},
): Promise<SpeechModelStatus[]> {
  const models = opts.models ?? speechModels()
  const baseUrl = ('baseUrl' in opts ? opts.baseUrl : env.OPENROUTER_BASE_URL)?.trim().replace(/\/$/, '')
  if (!baseUrl) return models.map((m) => ({ ...m, error: 'OPENROUTER_BASE_URL is not set' }))

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
