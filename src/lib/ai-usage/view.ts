import type { AiUsageOverview, AiUsageProductId } from './overview'
import { usageProductLabel, USAGE_PRODUCT_IDS } from './overview'

/** Pure view state of Settings → AI usage: the period switch and the daily bars. */

export const AI_USAGE_PERIODS = [
  { id: '7', label: '7 days', days: 7 },
  { id: '30', label: '30 days', days: 30 },
  { id: '90', label: '90 days', days: 90 },
  { id: 'all', label: 'All', days: null },
] as const
export type AiUsagePeriod = (typeof AI_USAGE_PERIODS)[number]['id']

/** The period the page's address names (30 days when it names none); null: not a period. */
export function periodOf(raw: string | null): AiUsagePeriod | null {
  if (raw === null) return '30'
  return AI_USAGE_PERIODS.find((p) => p.id === raw)?.id ?? null
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10)

function shiftDay(day: string, by: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + by)
  return dayOf(date)
}

/** The tool input of a period: whole UTC days, today included. */
export function periodRange(period: AiUsagePeriod, now: Date): { from?: string; to?: string } {
  const days = AI_USAGE_PERIODS.find((p) => p.id === period)!.days
  if (days === null) return {}
  const to = dayOf(now)
  return { from: shiftDay(to, 1 - days), to }
}

export type DailyBar = {
  date: string
  costUsd: number
  segments: { id: AiUsageProductId; label: string; costUsd: number }[]
}

/** One bar per day of the period (days without cost at zero), its products in catalog order. */
export function dailyBars(overview: AiUsageOverview): DailyBar[] {
  const first = overview.from ?? overview.daily[0]?.date
  const last = overview.to ?? overview.daily.at(-1)?.date
  if (first === undefined || last === undefined) return []
  const byDate = new Map(overview.daily.map((d) => [d.date, d]))
  const bars: DailyBar[] = []
  for (let date = first; date <= last; date = shiftDay(date, 1)) {
    const day = byDate.get(date)
    bars.push({
      date,
      costUsd: day?.costUsd ?? 0,
      segments: USAGE_PRODUCT_IDS.filter((id) => (day?.products[id] ?? 0) > 0).map((id) => ({
        id,
        label: usageProductLabel(id),
        costUsd: day!.products[id]!,
      })),
    })
  }
  return bars
}

/** The products with cost in the period, in catalog order (the chart's legend). */
export function usedProducts(overview: AiUsageOverview): AiUsageOverview['products'] {
  return overview.products.filter((p) => p.costUsd > 0)
}
