/**
 * The week view's day widths (Contribute 9ae58a4e), pure: each day's share
 * of the days' area in percent — they always sum to 100, and no day is
 * narrower than a readable minimum. Setting one day's width lets the other
 * days share the rest in their existing proportions.
 */

/** The narrowest a day gets, so an event's title stays readable. */
export const MIN_COLUMN_PX = 64

/** How far an arrow key moves a column edge, in percent. */
export const KEY_STEP = 2

export function equalWidths(n: number): number[] {
  return Array.from({ length: n }, () => 100 / n)
}

/** The minimum in percent of an area `areaPx` wide: `minPx`, but never more than an equal share. */
export function minPercent(areaPx: number, n: number, minPx = MIN_COLUMN_PX): number {
  if (!(areaPx > 0)) return 100 / n
  return Math.min(100 / n, (minPx / areaPx) * 100)
}

/** `total` shared by `weights`' proportions, none below `min` (needs total ≥ n × min). */
function share(weights: readonly number[], total: number, min: number): number[] {
  const out = weights.map(() => min)
  const pinned = new Set<number>()
  for (;;) {
    const free = weights.map((_, i) => i).filter((i) => !pinned.has(i))
    const rest = total - pinned.size * min
    const sum = free.reduce((a, i) => a + Math.max(weights[i], 0), 0)
    for (const i of free)
      out[i] = sum > 0 ? (Math.max(weights[i], 0) / sum) * rest : rest / free.length
    const under = free.filter((i) => out[i] < min)
    if (under.length === 0 || under.length === free.length) {
      for (const i of under) out[i] = min
      return out
    }
    for (const i of under) {
      pinned.add(i)
      out[i] = min
    }
  }
}

/** Widths fitted to a minimum (a narrower screen): the narrow days at it, the rest in proportion. */
export function fitWidths(widths: readonly number[], min: number): number[] {
  return share(widths, 100, min)
}

/** Day `index` at `width` (kept between the minimum and what leaves the others theirs); the others share the rest. */
export function setWidth(
  widths: readonly number[],
  index: number,
  width: number,
  min: number,
): number[] {
  const n = widths.length
  const w = Math.min(Math.max(width, min), 100 - (n - 1) * min)
  const others = share(
    widths.filter((_, i) => i !== index),
    100 - w,
    min,
  )
  others.splice(index, 0, w)
  return others
}

export function isEqualWidths(widths: readonly number[]): boolean {
  return widths.every((w) => Math.abs(w - 100 / widths.length) < 0.01)
}

/** Widths as stored (JSON): `n` positive numbers summing to 100, or null when absent or not that. */
export function parseWidths(raw: string | null, n: number): number[] | null {
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(value) || value.length !== n) return null
  if (!value.every((w) => typeof w === 'number' && Number.isFinite(w) && w > 0)) return null
  const sum = (value as number[]).reduce((a, b) => a + b, 0)
  return Math.abs(sum - 100) < 0.01 ? (value as number[]) : null
}
