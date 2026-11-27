import { describe, expect, it } from 'vitest'
import { mockEmbeddings } from './mock-gateway-embeddings.mjs'

describe('mockEmbeddings (mock gateway /v1/embeddings)', () => {
  it('answers one 1536-dimension unit vector per input, in order, in the OpenAI shape', () => {
    const out = mockEmbeddings({ model: 'mock-embed-model', input: ['alpha', 'beta'] })
    expect(out.status).toBe(200)
    expect(out.body.object).toBe('list')
    expect(out.body.model).toBe('mock-embed-model')
    expect(out.body.data.map((d) => d.index)).toEqual([0, 1])
    for (const d of out.body.data) {
      expect(d.object).toBe('embedding')
      expect(d.embedding).toHaveLength(1536)
      const norm = Math.sqrt(d.embedding.reduce((s, x) => s + x * x, 0))
      expect(norm).toBeCloseTo(1, 6)
    }
  })

  it('is deterministic: the same text gives the same vector, a different text a different one', () => {
    const a1 = mockEmbeddings({ model: 'm', input: 'Alpha launch date' }).body.data[0].embedding
    const a2 = mockEmbeddings({ model: 'm', input: 'Alpha launch date' }).body.data[0].embedding
    const b = mockEmbeddings({ model: 'm', input: 'something else' }).body.data[0].embedding
    expect(a1).toEqual(a2)
    expect(a1).not.toEqual(b)
  })

  it('refuses a request without input, loudly', () => {
    expect(mockEmbeddings({ model: 'm' }).status).toBe(400)
    expect(mockEmbeddings({ model: 'm', input: [] }).status).toBe(400)
  })
})
