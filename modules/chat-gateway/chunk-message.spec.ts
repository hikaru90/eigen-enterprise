import { describe, expect, it } from 'vitest'
import { chunkMessage } from './telegram'

describe('chunkMessage', () => {
  it('returns [] for empty string', () => {
    expect(chunkMessage('')).toEqual([])
  })

  it('returns [] for whitespace-only text', () => {
    expect(chunkMessage('  \n\n  ')).toEqual([])
  })

  it('returns a single unchanged chunk for short text', () => {
    expect(chunkMessage('hello')).toEqual(['hello'])
  })

  it('keeps short paragraphs together in one chunk', () => {
    expect(chunkMessage('a\n\nb')).toEqual(['a\n\nb'])
  })

  it('splits on paragraph boundaries when paragraphs do not fit together', () => {
    const p1 = 'x'.repeat(30)
    const p2 = 'y'.repeat(30)
    expect(chunkMessage(`${p1}\n\n${p2}`, 40)).toEqual([p1, p2])
  })

  it('packs paragraphs that fit within maxLen', () => {
    expect(chunkMessage('aaaa\n\nbb', 10)).toEqual(['aaaa\n\nbb'])
  })

  it('hard-wraps a single overlong paragraph without separators', () => {
    const text = 'z'.repeat(95)
    const chunks = chunkMessage(text, 40)
    expect(chunks).toHaveLength(3)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40)
    expect(chunks.join('')).toBe(text)
  })

  it('never exceeds maxLen for mixed paragraph sizes', () => {
    const text = ['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(10)].join('\n\n')
    const chunks = chunkMessage(text, 30)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(30)
  })

  it('respects exact-fit boundaries', () => {
    expect(chunkMessage('a'.repeat(10), 10)).toEqual(['a'.repeat(10)])
    expect(chunkMessage('a'.repeat(11), 10)).toEqual(['a'.repeat(10), 'a'])
  })

  it('throws RangeError for maxLen < 1', () => {
    expect(() => chunkMessage('x', 0)).toThrow(RangeError)
    expect(() => chunkMessage('x', -5)).toThrow(RangeError)
  })
})
