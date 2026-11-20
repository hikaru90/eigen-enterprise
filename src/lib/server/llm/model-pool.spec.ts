import { describe, expect, it } from 'vitest'
import {
  CHOOSABLE_SLOTS,
  MODEL_POOL,
  MODEL_SLOTS,
  ModelNotInPoolError,
  assertPoolModel,
  isPoolModel,
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
})
