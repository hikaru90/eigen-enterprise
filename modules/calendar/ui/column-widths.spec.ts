import { describe, expect, it } from 'vitest'
import {
  equalWidths,
  fitWidths,
  isEqualWidths,
  minPercent,
  parseWidths,
  setWidth,
} from './column-widths'

const sum = (w: number[]) => w.reduce((a, b) => a + b, 0)

describe('week column widths (percent of the days’ area)', () => {
  it('starts equal', () => {
    const w = equalWidths(7)
    expect(w).toHaveLength(7)
    for (const x of w) expect(x).toBeCloseTo(100 / 7)
    expect(sum(w)).toBeCloseTo(100)
    expect(isEqualWidths(w)).toBe(true)
  })

  it('the minimum: a readable width in pixels, never more than an equal share', () => {
    expect(minPercent(1000, 7, 64)).toBeCloseTo(6.4)
    expect(minPercent(300, 7, 64)).toBeCloseTo(100 / 7)
  })

  it('setting one day’s width: the other days share the rest, keeping their proportions', () => {
    const w = setWidth(equalWidths(7), 2, 40, 5)
    expect(w[2]).toBeCloseTo(40)
    expect(sum(w)).toBeCloseTo(100)
    for (const [i, x] of w.entries()) if (i !== 2) expect(x).toBeCloseTo(10)
    expect(isEqualWidths(w)).toBe(false)
    const again = setWidth(w, 0, 20, 5)
    expect(again[0]).toBeCloseTo(20)
    expect(again[2] / again[1]).toBeCloseTo(4) // Wednesday stays four times Tuesday
    expect(sum(again)).toBeCloseTo(100)
  })

  it('never below the minimum: a day stops at it, and others stop at it when one grows', () => {
    const narrow = setWidth(equalWidths(7), 3, 1, 6)
    expect(narrow[3]).toBeCloseTo(6)
    expect(sum(narrow)).toBeCloseTo(100)
    const wide = setWidth(equalWidths(7), 3, 99, 6)
    expect(wide[3]).toBeCloseTo(64) // 100 − 6 × 6
    for (const [i, x] of wide.entries()) if (i !== 3) expect(x).toBeCloseTo(6)
    // Uneven others: the small ones stop at the minimum, the rest share what is left.
    const uneven = setWidth([30, 4, 4, 30, 12, 10, 10], 0, 50, 6)
    expect(sum(uneven)).toBeCloseTo(100)
    for (const x of uneven) expect(x).toBeGreaterThanOrEqual(6 - 1e-9)
    expect(uneven[3] / uneven[4]).toBeCloseTo(30 / 12)
  })

  it('fits stored widths to a narrower screen: every day at least the minimum', () => {
    const w = fitWidths([70, 5, 5, 5, 5, 5, 5], 10)
    expect(sum(w)).toBeCloseTo(100)
    for (const x of w.slice(1)) expect(x).toBeCloseTo(10)
    expect(w[0]).toBeCloseTo(40)
  })

  it('reads stored widths: seven positive numbers summing to 100, else nothing', () => {
    const w = setWidth(equalWidths(7), 1, 30, 5)
    expect(parseWidths(JSON.stringify(w), 7)).toEqual(w)
    expect(parseWidths(null, 7)).toBeNull()
    expect(parseWidths('not json', 7)).toBeNull()
    expect(parseWidths(JSON.stringify([50, 50]), 7)).toBeNull()
    expect(parseWidths(JSON.stringify([10, 10, 10, 10, 10, 10, 10]), 7)).toBeNull()
    expect(parseWidths(JSON.stringify([-10, 20, 20, 20, 20, 20, 30]), 7)).toBeNull()
    expect(parseWidths(JSON.stringify(['a', 20, 20, 20, 20, 10, 10]), 7)).toBeNull()
  })
})
