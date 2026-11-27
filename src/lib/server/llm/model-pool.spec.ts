import { describe, expect, it } from 'vitest'
import {
  CHOOSABLE_SLOTS,
  MODEL_POOL,
  MODEL_SLOTS,
  ModelNotInPoolError,
  ModelNotServedError,
  POOL_PROVIDERS,
  assertPoolModel,
  chatModels,
  isPoolModel,
  isServedOn,
  modelMaxTools,
  modelSupportsTemperature,
  poolFor,
  providerRoute,
  recommendedModel,
  ttsSendsVoice,
} from './model-pool'

describe('the model pool', () => {
  it('has the five slots; four are dropdowns, embedding is fixed per install', () => {
    expect(MODEL_SLOTS).toEqual(['chat', 'stt', 'tts', 'decision', 'embedding'])
    expect(CHOOSABLE_SLOTS).toEqual(['chat', 'stt', 'tts', 'decision'])
  })

  it('recommends exactly one model per slot per provider, and only a model that provider serves', () => {
    expect(POOL_PROVIDERS).toEqual(['openrouter', 'opper'])
    for (const provider of POOL_PROVIDERS) {
      for (const slot of MODEL_SLOTS) {
        const pick = recommendedModel(slot, provider)
        expect(isServedOn(slot, pick, provider), `${slot} on ${provider}`).toBe(true)
        expect(MODEL_POOL.filter((m) => m.slot === slot && m.recommendedOn?.includes(provider))).toHaveLength(1)
      }
    }
  })

  it('carries the owner-decided models on OpenRouter: qwen3-asr-1.7b for speech to text, Jev for decisions', () => {
    expect(recommendedModel('stt', 'openrouter')).toBe('qwen/qwen3-asr-1.7b')
    expect(recommendedModel('tts', 'openrouter')).toBe('qwen/qwen-audio-3.0-tts-flash')
    expect(recommendedModel('decision', 'openrouter')).toBe('typesafe/jev-1.13')
    expect(recommendedModel('embedding', 'openrouter')).toBe('qwen/qwen3-embedding-8b')
  })

  it('carries the owner-decided models on Opper (2026-11-27): Voxtral speech, clef-flash decisions, all EU', () => {
    expect(recommendedModel('chat', 'opper')).toBe('~deepseek/deepseek-flash-latest')
    expect(recommendedModel('stt', 'opper')).toBe('mistral/voxtral-mini-transcribe-3-0')
    expect(recommendedModel('tts', 'opper')).toBe('mistral/voxtral-mini-tts-3-0')
    expect(recommendedModel('decision', 'opper')).toBe('ovhcloud/clef-flash')
    expect(recommendedModel('embedding', 'opper')).toBe('qwen/qwen3-embedding-8b')
    for (const id of ['mistral/voxtral-mini-transcribe-3-0', 'mistral/voxtral-mini-tts-3-0', 'ovhcloud/clef-flash']) {
      const entry = MODEL_POOL.find((m) => m.id === id)
      expect(entry, id).toMatchObject({ vettedOn: '2026-11-27', routes: { opper: id } })
      expect(entry!.routes.openrouter, id).toBeUndefined()
    }
  })

  it('routes every pool id on Opper to exactly the EU id the contract verified, and nothing else', () => {
    const opper = Object.fromEntries(MODEL_POOL.filter((m) => m.routes.opper).map((m) => [m.id, m.routes.opper]))
    expect(opper).toEqual({
      '~deepseek/deepseek-flash-latest': 'mistral/deepseek-v4-1-flash-1017',
      'openai/gpt-5-mini': 'azure/gpt-5-mini',
      'google/gemini-3.8-flash': 'vertexai/gemini-3.8-flash-eu',
      'qwen/qwen3.8-flash': 'alibaba:eu/qwen3.8-flash',
      'mistralai/mistral-large-4-0': 'mistral:eu/mistral-large-4',
      'qwen/qwen3-embedding-8b': 'ovhcloud/Qwen3-Embedding-8B',
      'mistral/voxtral-mini-transcribe-3-0': 'mistral/voxtral-mini-transcribe-3-0',
      'mistral/voxtral-mini-tts-3-0': 'mistral/voxtral-mini-tts-3-0',
      'ovhcloud/clef-flash': 'ovhcloud/clef-flash',
    })
  })

  it('keeps OpenRouter on the ids it always routed by (a pool id is its OpenRouter id)', () => {
    for (const m of MODEL_POOL) if (m.routes.openrouter) expect(m.routes.openrouter).toBe(m.id)
    expect(providerRoute('chat', 'openai/gpt-5-mini', 'openrouter')).toBe('openai/gpt-5-mini')
  })

  it('a pool model the provider does not serve fails loud, telling the owner to pick another in Settings → AI', () => {
    expect(providerRoute('stt', 'mistral/voxtral-mini-transcribe-3-0', 'opper')).toBe('mistral/voxtral-mini-transcribe-3-0')
    expect(() => providerRoute('stt', 'qwen/qwen3-asr-1.7b', 'opper')).toThrow(ModelNotServedError)
    expect(() => providerRoute('stt', 'qwen/qwen3-asr-1.7b', 'opper')).toThrow(
      /"qwen\/qwen3-asr-1.7b" is not available on Opper.*Settings → AI/,
    )
    expect(() => providerRoute('decision', 'typesafe/jev-1.13', 'opper')).toThrow(ModelNotServedError)
    expect(() => providerRoute('embedding', 'openai/text-embedding-3-small', 'opper')).toThrow(ModelNotServedError)
    expect(() => providerRoute('decision', 'ovhcloud/clef-flash', 'openrouter')).toThrow(/not available on OpenRouter/)
    // outside the pool is still its own error
    expect(() => providerRoute('chat', 'vendor/unvetted', 'opper')).toThrow(ModelNotInPoolError)
  })

  it('serves every chat model on every provider with one recommendation (co-workers pick from one list)', () => {
    for (const m of MODEL_POOL.filter((x) => x.slot === 'chat')) {
      for (const provider of POOL_PROVIDERS) expect(isServedOn('chat', m.id, provider), `${m.id} on ${provider}`).toBe(true)
    }
    expect(chatModels().map((m) => m.id)).toEqual(poolFor('chat', 'openrouter').map((m) => m.id))
    expect(chatModels()[0]).toMatchObject({ id: '~deepseek/deepseek-flash-latest', recommended: true })
  })

  it('every entry names the date it was vetted and why it is there', () => {
    for (const m of MODEL_POOL) {
      expect(m.vettedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(m.note.trim().length).toBeGreaterThan(0)
    }
  })

  it('a model is in the pool only for its own slot', () => {
    expect(isPoolModel('stt', 'qwen/qwen3-asr-1.7b')).toBe(true)
    expect(isPoolModel('chat', 'qwen/qwen3-asr-1.7b')).toBe(false)
  })

  it('a slot cannot hold a model outside the pool: validation fails loud', () => {
    expect(assertPoolModel('chat', '~deepseek/deepseek-flash-latest')).toBe('~deepseek/deepseek-flash-latest')
    expect(() => assertPoolModel('chat', 'vendor/unvetted-model')).toThrow(ModelNotInPoolError)
    expect(() => assertPoolModel('chat', 'vendor/unvetted-model')).toThrow(/not in the model pool for the chat slot/)
  })

  it('lists a slot for a provider: only what it serves, its recommendation first', () => {
    const chat = poolFor('chat', 'openrouter')
    expect(chat[0]!.recommendedOn).toContain('openrouter')
    expect(chat.every((m) => m.slot === 'chat')).toBe(true)
    expect(poolFor('stt', 'openrouter').map((m) => m.id)).toEqual(['qwen/qwen3-asr-1.7b'])
    expect(poolFor('stt', 'opper').map((m) => m.id)).toEqual(['mistral/voxtral-mini-transcribe-3-0'])
    expect(poolFor('decision', 'opper').map((m) => m.id)).toEqual(['ovhcloud/clef-flash'])
    expect(poolFor('embedding', 'opper').map((m) => m.id)).toEqual(['qwen/qwen3-embedding-8b'])
  })

  it('offers co-workers chat models from distinct families (AI Co-workers C2, vetted 2026-11-23)', () => {
    const widened = [
      'google/gemini-3.8-flash',
      'qwen/qwen3.8-flash',
      'mistralai/mistral-large-4-0',
    ]
    for (const id of widened) {
      const entry = MODEL_POOL.find((m) => m.id === id)
      expect(entry, id).toMatchObject({ slot: 'chat', vettedOn: '2026-11-23' })
      expect(entry?.recommendedOn, id).toBeUndefined()
    }
    const families = new Set(poolFor('chat', 'openrouter').map((m) => m.id.replace(/^~/, '').split('/')[0]))
    expect([...families].sort()).toEqual(['deepseek', 'google', 'mistralai', 'openai', 'qwen'])
  })

  it('holds no Claude Sonnet model in any slot (owner, 2026-11-26: too expensive, never offered)', () => {
    expect(MODEL_POOL.filter((m) => m.id.startsWith('anthropic/claude-sonnet'))).toEqual([])
    expect(isPoolModel('chat', 'anthropic/claude-sonnet-5.5')).toBe(false)
  })

  it('keeps the chat recommendation where it was: the widened pool adds choices, not a new default', () => {
    expect(recommendedModel('chat', 'openrouter')).toBe('~deepseek/deepseek-flash-latest')
  })

  it('declares supportsTemperature: false and maxTools: 128 on openai/gpt-5-mini and defaults others to true / null', () => {
    const gpt5Mini = MODEL_POOL.find((m) => m.id === 'openai/gpt-5-mini')
    expect(gpt5Mini).toMatchObject({ supportsTemperature: false, maxTools: 128 })

    expect(modelSupportsTemperature('openai/gpt-5-mini')).toBe(false)
    expect(modelSupportsTemperature('~deepseek/deepseek-flash-latest')).toBe(true)
    expect(modelSupportsTemperature('google/gemini-3.8-flash')).toBe(true)
    expect(modelSupportsTemperature('custom/unlisted')).toBe(true)

    expect(modelMaxTools('openai/gpt-5-mini')).toBe(128)
    expect(modelMaxTools('~deepseek/deepseek-flash-latest')).toBeNull()
    expect(modelMaxTools('google/gemini-3.8-flash')).toBeNull()
    expect(modelMaxTools('custom/unlisted')).toBeNull()
  })

  it('Voxtral TTS speaks in its own voice: the app voice (a Qwen voice name) is never sent to it', () => {
    expect(ttsSendsVoice('mistral/voxtral-mini-tts-3-0')).toBe(false)
    expect(ttsSendsVoice('qwen/qwen-audio-3.0-tts-flash')).toBe(true)
  })
})
