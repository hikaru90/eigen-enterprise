import { describe, expect, it } from 'vitest'
import { aiUsageRowsFromOs } from './ai-usage.ts'

const row = { day: '2026-11-26', task: 'assistant.turn', model: 'm/one', calls: 1, promptTokens: 10, completionTokens: 2, cachedTokens: 0, costUsd: 0.001 }

describe("os's AI usage answer", () => {
  it('passes valid rows through', () => {
    expect(aiUsageRowsFromOs({ rows: [row, { ...row, task: null, model: null }] })).toEqual([row, { ...row, task: null, model: null }])
    expect(aiUsageRowsFromOs({ rows: [] })).toEqual([])
  })

  it('anything else fails loud, naming where', () => {
    expect(() => aiUsageRowsFromOs(null)).toThrow(/without valid usage rows/)
    expect(() => aiUsageRowsFromOs({ seats: 3 })).toThrow(/rows/)
    expect(() => aiUsageRowsFromOs({ rows: [{ ...row, costUsd: -1 }] })).toThrow(/rows\.0\.costUsd/)
    expect(() => aiUsageRowsFromOs({ rows: [{ ...row, day: 'yesterday' }] })).toThrow(/rows\.0\.day/)
  })
})
