/**
 * The PDF viewer's geometry, kept pure so it can be tested: every page's
 * size is known before anything is drawn (no layout jumps), pages stack
 * top to bottom with a gap, and the zoom scales them all.
 * Sizes are CSS pixels at 100% (a PDF point is 1/72 in, a CSS pixel 1/96 in).
 */

export type PageSize = { width: number; height: number }

/** CSS pixels per PDF point at 100%. */
export const CSS_PER_POINT = 96 / 72
/** Space above the first page, below the last, and beside the widest. */
export const PAGE_PAD = 16
export const PAGE_GAP = 12
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8
export const ZOOM_STEPS = [
  0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8,
]
/** Largest canvas drawn (pixels); bigger pages draw at a lower pixel ratio. */
export const MAX_CANVAS_PIXELS = 16_777_216

export function pageTops(sizes: PageSize[], zoom: number): number[] {
  const tops: number[] = []
  let y = PAGE_PAD
  for (const s of sizes) {
    tops.push(y)
    y += Math.floor(s.height * zoom) + PAGE_GAP
  }
  return tops
}

export function totalHeight(sizes: PageSize[], zoom: number): number {
  if (sizes.length === 0) return 0
  return (
    2 * PAGE_PAD +
    sizes.reduce((h, s) => h + Math.floor(s.height * zoom), 0) +
    (sizes.length - 1) * PAGE_GAP
  )
}

/** The page whose slot (page plus the gap below it) holds `y`. */
export function pageAt(tops: number[], y: number): number {
  let lo = 0
  let hi = tops.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (tops[mid]! <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** First and last page touching [top − overscan, top + height + overscan]; [0, −1] when there are none. */
export function visibleRange(
  tops: number[],
  sizes: PageSize[],
  zoom: number,
  top: number,
  height: number,
  overscan: number,
): [number, number] {
  if (tops.length === 0) return [0, -1]
  let first = pageAt(tops, top - overscan)
  if (tops[first]! + Math.floor(sizes[first]!.height * zoom) < top - overscan)
    first = Math.min(first + 1, tops.length - 1)
  const last = pageAt(tops, top + height + overscan)
  return [first, Math.max(first, last)]
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** Zoom so the widest page fills the width. */
export function fitWidth(sizes: PageSize[], width: number): number {
  const widest = Math.max(...sizes.map((s) => s.width))
  return clampZoom((width - 2 * PAGE_PAD) / widest)
}

/** Zoom so the whole page shows. */
export function fitPage(size: PageSize, width: number, height: number): number {
  return clampZoom(
    Math.min((width - 2 * PAGE_PAD) / size.width, (height - 2 * PAGE_PAD) / size.height),
  )
}

/** The next zoom step up (`dir` 1) or down (−1) from any zoom. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const eps = 1e-6
  const next =
    dir > 0 ? ZOOM_STEPS.find((z) => z > zoom + eps) : ZOOM_STEPS.findLast((z) => z < zoom - eps)
  return next ?? (dir > 0 ? MAX_ZOOM : MIN_ZOOM)
}

/** The pixel ratio to draw a page of this CSS size at: the device's, lowered for huge canvases. */
export function canvasPixelRatio(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  const pixels = cssWidth * cssHeight * devicePixelRatio ** 2
  if (pixels <= MAX_CANVAS_PIXELS) return devicePixelRatio
  return Math.floor(Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight)) * 1000) / 1000
}
