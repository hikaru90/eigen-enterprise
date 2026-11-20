import { describe, expect, it } from 'vitest'
import {
  canvasPixelRatio,
  clampZoom,
  fitPage,
  fitWidth,
  PAGE_GAP,
  PAGE_PAD,
  pageAt,
  pageTops,
  stepZoom,
  totalHeight,
  visibleRange,
} from './layout'

const sizes = [
  { width: 600, height: 800 },
  { width: 800, height: 600 },
  { width: 600, height: 800 },
]

describe('PDF viewer layout', () => {
  it('stacks pages with a gap, scaled by the zoom', () => {
    expect(pageTops(sizes, 1)).toEqual([
      PAGE_PAD,
      PAGE_PAD + 800 + PAGE_GAP,
      PAGE_PAD + 1400 + 2 * PAGE_GAP,
    ])
    expect(pageTops(sizes, 0.5)).toEqual([
      PAGE_PAD,
      PAGE_PAD + 400 + PAGE_GAP,
      PAGE_PAD + 700 + 2 * PAGE_GAP,
    ])
    expect(totalHeight(sizes, 1)).toBe(2 * PAGE_PAD + 2200 + 2 * PAGE_GAP)
  })

  it('finds the page at a point and the pages near the viewport', () => {
    const tops = pageTops(sizes, 1)
    expect(pageAt(tops, 0)).toBe(0)
    expect(pageAt(tops, tops[1]! - 1)).toBe(0)
    expect(pageAt(tops, tops[1]!)).toBe(1)
    expect(pageAt(tops, 99_999)).toBe(2)
    expect(visibleRange(tops, sizes, 1, 0, 500, 0)).toEqual([0, 0])
    expect(visibleRange(tops, sizes, 1, 700, 500, 0)).toEqual([0, 1])
    expect(visibleRange(tops, sizes, 1, 700, 500, 1000)).toEqual([0, 2])
    expect(visibleRange([], [], 1, 0, 500, 0)).toEqual([0, -1])
  })

  it('fits the widest page to the width, or a whole page into the view', () => {
    expect(fitWidth(sizes, 800 + 2 * PAGE_PAD)).toBe(1)
    expect(fitWidth(sizes, 400 + 2 * PAGE_PAD)).toBe(0.5)
    expect(fitPage(sizes[0]!, 2000, 400 + 2 * PAGE_PAD)).toBe(0.5)
    expect(fitPage(sizes[1]!, 400 + 2 * PAGE_PAD, 2000)).toBe(0.5)
  })

  it('zoom steps up and down from any zoom and stays in range', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(1.03, 1)).toBe(1.1)
    expect(stepZoom(1.03, -1)).toBe(1)
    expect(stepZoom(8, 1)).toBe(8)
    expect(stepZoom(0.1, -1)).toBe(0.1)
    expect(clampZoom(20)).toBe(8)
    expect(clampZoom(0.01)).toBe(0.1)
  })

  it('draws at the device pixel ratio, capped for huge canvases', () => {
    expect(canvasPixelRatio(600, 800, 2)).toBe(2)
    const r = canvasPixelRatio(6000, 8000, 2)
    expect(6000 * r * (8000 * r)).toBeLessThanOrEqual(16_777_216)
    expect(r).toBeGreaterThan(0)
  })
})
