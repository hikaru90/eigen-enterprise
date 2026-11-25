import { parseRange, rangeName, type Range } from './ref'
import { XlsxError } from './workbook'

/**
 * Lists of ranges as SpreadsheetML writes them (ST_Sqref, ECMA-376 Part 1
 * §18.18.76: "A1:B4 D7"), shared by conditional formats, validations and
 * protected ranges: read, written, intersected and cut — when rules are
 * cleared from a selection the rest of their ranges stays, as in Excel.
 */

export function parseSqref(text: string): Range[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((t) => {
      const r = parseRange(t)
      return r ? [r] : []
    })
}

/** A range list typed by a person or tool ("A1:B4 D7", commas allowed too): refused when a part isn't a range. */
export function requireSqref(text: string): Range[] {
  const parts = text.split(/[\s,;]+/).filter(Boolean)
  if (parts.length === 0) throw new XlsxError('Give the cells, like A1:B10.')
  return parts.map((t) => {
    const r = parseRange(t)
    if (!r) throw new XlsxError(`“${t}” is not a cell range (like A1:C4).`)
    return r
  })
}

export const sqrefText = (ranges: Range[]) => ranges.map(rangeName).join(' ')

export const inRanges = (ranges: Range[], row: number, col: number) =>
  ranges.some((r) => row >= r.top && row <= r.bottom && col >= r.left && col <= r.right)

export function overlaps(a: Range, b: Range): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom
}

/** `r` without the cells of `cut`: up to four rectangles (above, below, left, right). */
export function subtract(r: Range, cut: Range): Range[] {
  if (!overlaps(r, cut)) return [r]
  const out: Range[] = []
  if (cut.top > r.top) out.push({ ...r, bottom: cut.top - 1 })
  if (cut.bottom < r.bottom) out.push({ ...r, top: cut.bottom + 1 })
  const top = Math.max(r.top, cut.top)
  const bottom = Math.min(r.bottom, cut.bottom)
  if (cut.left > r.left) out.push({ top, bottom, left: r.left, right: cut.left - 1 })
  if (cut.right < r.right) out.push({ top, bottom, left: cut.right + 1, right: r.right })
  return out
}

/** Every range of `ranges` with the cells of every `cuts` range taken out. */
export function subtractAll(ranges: Range[], cuts: Range[]): Range[] {
  let cur = ranges
  for (const c of cuts) cur = cur.flatMap((r) => subtract(r, c))
  return cur
}

/** The first range's top-left cell: where a rule's relative formulas are written from. */
export function anchorOf(ranges: Range[]): { row: number; col: number } {
  const r = ranges[0]
  return r ? { row: r.top, col: r.left } : { row: 0, col: 0 }
}
