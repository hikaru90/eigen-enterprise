import { describe, expect, it } from 'vitest'
import {
  CHOOSABLE_SLOTS,
  MODEL_POOL,
  MODEL_SLOTS,
  ModelNotInPoolError,
  assertPoolModel,
  isPoolModel,
  modelMaxTools,
  modelSupportsTemperature,
  poolFor,
  recommendedModel,
} from './model-pool'

describe('the model pool', () => {
  it('has the five slots; four are dropdowns, embedding is fixed per install', () => {
    expect(MODEL_SLOTS).toEqual(['chat', 'stt', 'tts', 'decision', 'embedding'])
    expect(CHOOSABLE_SLOTS).toEqual(['chat', 'stt', 'tts', 'decision'])
  })

  it('recommends exactly one model per slot', () => {
    for (const slot of MODEL_SLOTS) expect(() => recommendedModel(slot)).not.toThrow()
  })

  it('carries the owner-decided models: qwen3-asr-1.7b for speech to text, Jev for decisions', () => {
    expect(recommendedModel('stt')).toBe('qwen/qwen3-asr-1.7b')
    expect(recommendedModel('decision')).toBe('typesafe/jev-1.13')
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
    expect(assertPoolModel('chat', recommendedModel('chat'))).toBe(recommendedModel('chat'))
    expect(() => assertPoolModel('chat', 'vendor/unvetted-model')).toThrow(ModelNotInPoolError)
    expect(() => assertPoolModel('chat', 'vendor/unvetted-model')).toThrow(/not in the model pool for the chat slot/)
  })

  it('lists a slot recommended first', () => {
    const chat = poolFor('chat')
    expect(chat[0]!.recommended).toBe(true)
    expect(chat.every((m) => m.slot === 'chat')).toBe(true)
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
      expect(entry?.recommended, id).toBeUndefined()
    }
    const families = new Set(poolFor('chat').map((m) => m.id.replace(/^~/, '').split('/')[0]))
    expect([...families].sort()).toEqual(['deepseek', 'google', 'mistralai', 'openai', 'qwen'])
  })

  it('holds no Claude Sonnet model in any slot (owner, 2026-11-26: too expensive, never offered)', () => {
    expect(MODEL_POOL.filter((m) => m.id.startsWith('anthropic/claude-sonnet'))).toEqual([])
    expect(isPoolModel('chat', 'anthropic/claude-sonnet-5.5')).toBe(false)
  })

  it('keeps the chat recommendation where it was: the widened pool adds choices, not a new default', () => {
    expect(recommendedModel('chat')).toBe('~deepseek/deepseek-flash-latest')
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
})
