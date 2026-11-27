import { describe, expect, it } from 'vitest'
import { foldAiUsage, type AiUsageRow } from './overview'
import { AI_USAGE_PERIODS, dailyBars, formatShown, periodLabel, periodOf, periodRange, providerUsdOf, shownAmount, usedProducts } from './view'

const row = (day: string, task: string | null, costUsd: number, eigenInferenceUsd = 0): AiUsageRow => ({
  userId: 'u', name: 'Mia', kind: 'person', task, model: 'm', day, costUsd, calls: 1, promptTokens: 0, completionTokens: 0, cachedTokens: 0, eigenInferenceUsd,
})
const NOW = new Date('2026-11-27T15:00:00Z')

describe('AI usage periods', () => {
  it('reads the asked period, 30 days without one, and refuses nothing else silently', () => {
    expect(periodOf(null)).toBe('30')
    expect(periodOf('7')).toBe('7')
    expect(periodOf('all')).toBe('all')
    expect(periodOf('12')).toBeNull()
  })

  it('the pills say what they span (Contribute f3d03bd0): last N days, all time', () => {
    expect(AI_USAGE_PERIODS.map((p) => p.label)).toEqual(['Last 7 days', 'Last 30 days', 'Last 90 days', 'All time'])
  })

  it('on the hosted plan the pill names the period as invoiced (Contribute cfc2df03); self-hosted stays plain', () => {
    const billing = { currency: 'EUR' as const, markup: 1.2, usdToEur: 0.95, rateDay: '2026-11-27' }
    expect(periodLabel('7', null)).toBe('Last 7 days')
    expect(periodLabel('7', billing)).toBe('Last 7 days (invoiced)')
    expect(periodLabel('all', billing)).toBe('All time (invoiced)')
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
    expect(bars[0]).toEqual({ date: '2026-11-22', amount: 0, segments: [] })
    expect(bars[3]!.segments.map((s) => [s.id, s.amount])).toEqual([
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

  it('self-hosted: amounts are the logged USD', () => {
    expect(shownAmount(overview.totals, overview.billing)).toBe(3.5)
    expect(formatShown(3.5, overview.billing)).toBe('$3.50')
  })
})

describe('daily bars on the hosted plan (eigenInference invoiced in EUR)', () => {
  const billing = { currency: 'EUR' as const, markup: 1.2, usdToEur: 0.95, rateDay: '2026-11-27' }
  // the assistant call ran on eigenInference; the brain one on the company's own key
  const overview = foldAiUsage(
    [row('2026-11-23', 'brain.compose_answer', 1, 0), row('2026-11-25', 'assistant.turn', 2.4, 2)],
    { from: '2026-11-22', to: '2026-11-26' },
    billing,
  )

  it('the bars, the amounts and the legend are € invoiced', () => {
    const bars = dailyBars(overview)
    expect(bars[1]).toEqual({ date: '2026-11-23', amount: 0, segments: [] })
    expect(bars[3]).toEqual({ date: '2026-11-25', amount: 2.28, segments: [{ id: 'assistant', label: 'Assistant', amount: 2.28 }] })
    expect(shownAmount(overview.totals, billing)).toBe(2.28)
    expect(formatShown(2.28, billing)).toBe('€2.28')
    expect(usedProducts(overview).map((p) => p.id)).toEqual(['assistant'])
  })

  it('an amount without its € (a broken overview) fails loud instead of showing zero', () => {
    expect(() => shownAmount({ costUsd: 1, calls: 1, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, billing)).toThrow(/invoiced/)
    expect(() => providerUsdOf({ costUsd: 1, calls: 1, promptTokens: 0, completionTokens: 0, cachedTokens: 0 })).toThrow(/provider USD/)
    expect(providerUsdOf(overview.totals)).toBe(2)
  })
})
