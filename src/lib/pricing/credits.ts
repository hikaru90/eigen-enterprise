/** Display credits per one US dollar of gateway spend (1 credit = $0.001). */
export const CREDITS_PER_USD = 1000

/** Convert all-in stored total USD (gateway + markup) to a numeric credit amount. */
export function totalCostUsdToCredits(totalCostUsd: string): number {
  const parsed = Number(totalCostUsd)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed * CREDITS_PER_USD
}

/** User-facing Activity / totals label for a stored totalCostUsd string. */
export function formatActivityCredits(totalCostUsd: string): string {
  return formatCreditsAmount(totalCostUsdToCredits(totalCostUsd))
}

function formatCreditsAmount(credits: number): string {
  if (credits === 0) return '0'
  if (credits < 1) {
    const formatted = credits.toFixed(3).replace(/\.?0+$/, '')
    return formatted.length > 0 ? formatted : '0'
  }
  if (Number.isInteger(credits)) {
    return credits.toLocaleString('en-US')
  }
  return credits.toLocaleString('en-US', { maximumFractionDigits: 2 })
}
