import { describe, expect, it } from 'vitest'
import { foldAiUsage, type AiUsageRow } from './overview'
import { dailyBars, periodOf, periodRange, usedProducts } from './view'

const row = (day: string, task: string | null, costUsd: number): AiUsageRow => ({
  userId: 'u', name: 'Mia', kind: 'person', task, model: 'm', day, costUsd, calls: 1, promptTokens: 0, completionTokens: 0, cachedTokens: 0,
})
const NOW = new Date('2026-11-27T15:00:00Z')

describe('AI usage periods', () => {
  it('reads the asked period, 30 days without one, and refuses nothing else silently', () => {
    expect(periodOf(null)).toBe('30')
    expect(periodOf('7')).toBe('7')
    expect(periodOf('all')).toBe('all')
    expect(periodOf('12')).toBeNull()
  })

  it('counts whole UTC days, today included', () => {
    expect(periodRange('7', NOW)).toEqual({ from: '2026-11-21', to: '2026-11-27' })
    expect(periodRange('30', NOW)).toEqual({ from: '2026-10-29', to: '2026-11-27' })
    expect(periodRange('all', NOW)).toEqual({})
  })
})

describe('daily bars', () => {
  const overview = foldAiUsage(
    [row('2026-11-23', 'brain.compose_answer', 1), row('2026-11-25', 'assistant.turn', 2), row('2026-11-25', null, 0.5)],
    { from: '2026-11-22', to: '2026-11-26' },
  )

  it('shows every day of the period, days without calls at zero, products in catalog order', () => {
    const bars = dailyBars(overview)
    expect(bars.map((b) => b.date)).toEqual(['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'])
    expect(bars[0]).toEqual({ date: '2026-11-22', costUsd: 0, segments: [] })
    expect(bars[3]!.segments.map((s) => [s.id, s.costUsd])).toEqual([
      ['assistant', 2],
      ['unattributed', 0.5],
    ])
  })

  it('without a period spans from the first day on record to the last', () => {
    expect(dailyBars({ ...overview, from: null, to: null }).map((b) => b.date)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25'])
    expect(dailyBars(foldAiUsage([], { from: null, to: null }))).toEqual([])
  })

  it('names the products that cost something, in catalog order', () => {
    expect(usedProducts(overview).map((p) => p.id)).toEqual(['assistant', 'brain', 'unattributed'])
  })
})
