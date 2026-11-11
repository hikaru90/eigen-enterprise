import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkSpeechModelEndpoints,
  reportSpeechModelsAtStartup,
  resetSpeechModelCheckCache,
  speechModelProblems,
} from './speech-models'

const BASE = 'https://openrouter.ai/api/v1'
const MODELS = [
  { feature: 'dictation' as const, model: 'qwen/qwen3-asr-0.6b' },
  { feature: 'voice' as const, model: 'qwen/qwen3-tts-flash-2026-02-10' },
]

function endpointsBody(providers: string[]) {
  return { data: { id: 'x', endpoints: providers.map((provider_name) => ({ provider_name, status: 0 })) } }
}

function fakeFetch(byModel: Record<string, unknown | number>) {
  return vi.fn(async (url: string) => {
    const model = decodeURIComponent(url.replace(`${BASE}/models/`, '').replace('/endpoints', ''))
    const answer = byModel[model]
    if (typeof answer === 'number') return new Response('nope', { status: answer })
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

beforeEach(() => resetSpeechModelCheckCache())

describe('checkSpeechModelEndpoints', () => {
  it('counts the live endpoints of each speech model from OpenRouter’s public list', async () => {
    const fetchFn = fakeFetch({
      'qwen/qwen3-asr-0.6b': endpointsBody(['PrimeIntellect', 'DeepInfra']),
      'qwen/qwen3-tts-flash-2026-02-10': endpointsBody([]),
    })
    const out = await checkSpeechModelEndpoints({ fetchFn, baseUrl: BASE, models: MODELS })
    expect(out).toEqual([
      { feature: 'dictation', model: 'qwen/qwen3-asr-0.6b', endpoints: 2, providers: ['PrimeIntellect', 'DeepInfra'] },
      { feature: 'voice', model: 'qwen/qwen3-tts-flash-2026-02-10', endpoints: 0, providers: [] },
    ])
    expect(fetchFn).toHaveBeenCalledWith(`${BASE}/models/qwen/qwen3-asr-0.6b/endpoints`, expect.anything())
  })

  it('a failed lookup is reported as such, never as "fine"', async () => {
    const fetchFn = fakeFetch({ 'qwen/qwen3-asr-0.6b': 503, 'qwen/qwen3-tts-flash-2026-02-10': { nonsense: true } })
    const out = await checkSpeechModelEndpoints({ fetchFn, baseUrl: BASE, models: MODELS })
    expect(out[0]).toEqual({ feature: 'dictation', model: 'qwen/qwen3-asr-0.6b', error: 'OpenRouter answered 503' })
    expect(out[1]).toMatchObject({ feature: 'voice', error: expect.stringMatching(/unexpected/) })
  })

  it('without OPENROUTER_BASE_URL there is nothing to ask: every model says so', async () => {
    const fetchFn = vi.fn()
    const out = await checkSpeechModelEndpoints({ fetchFn, baseUrl: undefined, models: MODELS })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(out.every((s) => 'error' in s && /OPENROUTER_BASE_URL/.test(s.error))).toBe(true)
  })

  it('is cached for a while, so pages that show it stay fast', async () => {
    const fetchFn = fakeFetch({
      'qwen/qwen3-asr-0.6b': endpointsBody(['A']),
      'qwen/qwen3-tts-flash-2026-02-10': endpointsBody(['B']),
    })
    await checkSpeechModelEndpoints({ fetchFn, baseUrl: BASE, models: MODELS })
    await checkSpeechModelEndpoints({ fetchFn, baseUrl: BASE, models: MODELS })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})

describe('speechModelProblems', () => {
  it('lists every model with no endpoints or a failed lookup, for the startup log', () => {
    const problems = speechModelProblems([
      { feature: 'dictation', model: 'a', endpoints: 2, providers: ['x', 'y'] },
      { feature: 'voice', model: 'b', endpoints: 0, providers: [] },
      { feature: 'dictation', model: 'c', error: 'OpenRouter answered 503' },
    ])
    expect(problems).toEqual([
      'voice model b has no endpoints on OpenRouter — every call will fail',
      'dictation model c could not be checked: OpenRouter answered 503',
    ])
  })
})

describe('reportSpeechModelsAtStartup', () => {
  it('logs every problem as an error, so a dead model is seen on deploy, not on the first recording', async () => {
    const log = { error: vi.fn() }
    await reportSpeechModelsAtStartup(log, async () => [
      { feature: 'dictation', model: 'a', endpoints: 1, providers: ['x'] },
      { feature: 'voice', model: 'b', endpoints: 0, providers: [] },
    ])
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith('[speech] voice model b has no endpoints on OpenRouter — every call will fail')
  })

  it('stays quiet when every model has endpoints', async () => {
    const log = { error: vi.fn() }
    await reportSpeechModelsAtStartup(log, async () => [{ feature: 'dictation', model: 'a', endpoints: 1, providers: ['x'] }])
    expect(log.error).not.toHaveBeenCalled()
  })
})
