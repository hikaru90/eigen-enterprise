import { describe, expect, it } from 'vitest'
import { fitEmbeddingResponse, isMatryoshkaModel } from './matryoshka'

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0))
const vec = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i))

describe('Matryoshka embedding models', () => {
  it('knows the models trained to be shortened', () => {
    expect(isMatryoshkaModel('qwen/qwen3-embedding-8b')).toBe(true)
    expect(isMatryoshkaModel('qwen/qwen3-embedding-4b')).toBe(true)
    expect(isMatryoshkaModel('openai/text-embedding-3-small')).toBe(true)
    expect(isMatryoshkaModel('openai/text-embedding-ada-002')).toBe(false)
  })

  it('shortens a 4096-dim Qwen3 vector to the first 1536 values, unit length again', () => {
    const long = vec(4096, (i) => (i % 7) - 3 + 0.5)
    const out = fitEmbeddingResponse('qwen/qwen3-embedding-8b', { data: [{ embedding: long }] }, 1536) as {
      data: { embedding: number[] }[]
    }
    const got = out.data[0]!.embedding
    expect(got).toHaveLength(1536)
    expect(norm(got)).toBeCloseTo(1, 10)
    // Same direction as the prefix: every value is the prefix value times one positive factor.
    const scale = got[0]! / long[0]!
    expect(scale).toBeGreaterThan(0)
    got.forEach((x, i) => expect(x).toBeCloseTo(long[i]! * scale, 12))
  })

  it('shortens every item of a batch and keeps the other response fields', () => {
    const body = { model: 'qwen/qwen3-embedding-8b', usage: { cost: 0.0001 }, data: [{ embedding: vec(4096, () => 1) }, { embedding: vec(4096, () => -2) }] }
    const out = fitEmbeddingResponse('qwen/qwen3-embedding-8b', body, 1536) as typeof body
    expect(out.usage).toEqual({ cost: 0.0001 })
    expect(out.data.map((d) => d.embedding.length)).toEqual([1536, 1536])
  })

  it('leaves a response already at the requested size untouched (the gateway shortened it)', () => {
    const body = { data: [{ embedding: vec(1536, () => 0.1) }] }
    expect(fitEmbeddingResponse('qwen/qwen3-embedding-8b', body, 1536)).toBe(body)
  })

  it('never shortens a model that is not Matryoshka-trained: the length check downstream fails loud', () => {
    const body = { data: [{ embedding: vec(3072, () => 0.1) }] }
    expect(fitEmbeddingResponse('some/other-embedding', body, 1536)).toBe(body)
  })

  it('never pads a vector shorter than requested', () => {
    const body = { data: [{ embedding: vec(1024, () => 0.1) }] }
    expect(fitEmbeddingResponse('qwen/qwen3-embedding-8b', body, 1536)).toBe(body)
  })

  it('refuses an all-zero vector instead of dividing by zero', () => {
    const body = { data: [{ embedding: vec(4096, () => 0) }] }
    expect(() => fitEmbeddingResponse('qwen/qwen3-embedding-8b', body, 1536)).toThrow(/zero/)
  })
})
