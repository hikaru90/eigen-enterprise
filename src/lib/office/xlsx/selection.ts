import type { SheetEditor } from './editor'
import type { SheetData } from './workbook'
import { currentRegion } from './filter'
import { cellKey, type Range } from './ref'

/**
 * Grid selection helpers: multi-range selection normalization, deduplicated
 * status bar aggregates (Sum / Average / Count), Excel Ctrl+Arrow data-block
 * jumping, Tab/Enter movement inside multi-cell selections, and Ctrl+A
 * current-region expansion.
 */

export type Pos = { row: number; col: number }
export type NavDir = 'up' | 'down' | 'left' | 'right'

export function normalizeRange(a: Pos, b: Pos): Range {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.col, b.col),
    right: Math.max(a.col, b.col),
  }
}

export function rangeContains(r: Range, p: Pos): boolean {
  return p.row >= r.top && p.row <= r.bottom && p.col >= r.left && p.col <= r.right
}

export function sameRange(a: Range, b: Range): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right
}

export function rangeCellCount(ranges: Range[]): number {
  if (ranges.length === 1) {
    const r = ranges[0]!
    return (r.bottom - r.top + 1) * (r.right - r.left + 1)
  }
  const seen = new Set<number>()
  for (const r of ranges) {
    for (let row = r.top; row <= r.bottom; row++) {
      for (let col = r.left; col <= r.right; col++) seen.add(cellKey(row, col))
    }
  }
  return seen.size
}

export type SelectionStats = {
  /** Total non-empty cells across the selection (deduplicated). */
  count: number
  /** Numeric cells across the selection (for Average). */
  numericCount: number
  sum: number
  average: number | null
}

/** Computes Count, Sum and Average across `ranges`, counting overlapping cells once. */
export function selectionStats(
  ed: SheetEditor,
  sheet: string,
  ranges: Range[],
  maxInspect = 50_000,
): SelectionStats {
  const data = ed.wb.sheet(sheet)
  const calc = ed.calc()
  const spills = calc.spills(data.info.name)
  const seen = new Set<number>()
  let count = 0
  let numericCount = 0
  let sum = 0

  const inspectCell = (r: number, c: number) => {
    const k = cellKey(r, c)
    if (seen.has(k)) return
    seen.add(k)
    const out = calc.cell(data.info.name, r, c)
    if (out.value === null || out.value === '') return
    count++
    if (typeof out.value === 'number' && Number.isFinite(out.value)) {
      numericCount++
      sum += out.value
    }
  }

  for (const range of ranges) {
    const area = (range.bottom - range.top + 1) * (range.right - range.left + 1)
    if (area <= maxInspect) {
      // Iterate only populated cells + spill cells in the range so huge whole-column selections stay O(populated)
      for (const cell of data.cells.values()) {
        if (
          cell.row >= range.top &&
          cell.row <= range.bottom &&
          cell.col >= range.left &&
          cell.col <= range.right
        ) {
          inspectCell(cell.row, cell.col)
        }
      }
      for (const sp of spills) {
        const sr = sp.range
        for (let r = Math.max(sr.top, range.top); r <= Math.min(sr.bottom, range.bottom); r++) {
          for (let c = Math.max(sr.left, range.left); c <= Math.min(sr.right, range.right); c++) {
            inspectCell(r, c)
          }
        }
      }
    } else {
      for (const cell of data.cells.values()) {
        if (
          cell.row >= range.top &&
          cell.row <= range.bottom &&
          cell.col >= range.left &&
          cell.col <= range.right
        ) {
          inspectCell(cell.row, cell.col)
        }
      }
    }
  }

  return {
    count,
    numericCount,
    sum,
    average: numericCount > 0 ? sum / numericCount : null,
  }
}

/** Whether `(r, c)` holds visible non-empty content. */
function isFilled(data: SheetData | null, r: number, c: number): boolean {
  if (!data) return false
  const cell = data.cells.get(cellKey(r, c))
  return !!cell && (cell.value !== null || cell.formula !== null)
}

function isRowHidden(data: SheetData | null, r: number): boolean {
  return !!data?.rows.get(r)?.hidden
}

function isColHidden(data: SheetData | null, c: number): boolean {
  return !!data?.cols.find((x) => c >= x.min && c <= x.max)?.hidden
}

/** Excel `Ctrl+Arrow` jump from `from` in `dir`, skipping hidden rows/columns. */
export function jumpEdge(
  data: SheetData | null,
  from: Pos,
  dir: NavDir,
  rows: number,
  cols: number,
): Pos {
  const dr = dir === 'down' ? 1 : dir === 'up' ? -1 : 0
  const dc = dir === 'right' ? 1 : dir === 'left' ? -1 : 0
  const limit = (r: number, c: number) => r >= 0 && r < rows && c >= 0 && c < cols
  const hidden = (r: number, c: number) => (dr !== 0 ? isRowHidden(data, r) : isColHidden(data, c))

  const stepFrom = (r: number, c: number): Pos | null => {
    let nr = r + dr
    let nc = c + dc
    while (limit(nr, nc) && hidden(nr, nc)) {
      nr += dr
      nc += dc
    }
    return limit(nr, nc) ? { row: nr, col: nc } : null
  }

  const first = stepFrom(from.row, from.col)
  if (!first) return from

  const curFilled = isFilled(data, from.row, from.col)
  const nextFilled = isFilled(data, first.row, first.col)

  if (curFilled && nextFilled) {
    // Walk to the last filled cell before a blank (or edge)
    let cur = first
    while (true) {
      const nxt = stepFrom(cur.row, cur.col)
      if (!nxt || !isFilled(data, nxt.row, nxt.col)) return cur
      cur = nxt
    }
  }

  // Otherwise jump to the next filled cell, or the sheet edge if none
  let cur = first
  let lastVisible: Pos
  while (true) {
    if (isFilled(data, cur.row, cur.col)) return cur
    lastVisible = cur
    const nxt = stepFrom(cur.row, cur.col)
    if (!nxt) return lastVisible
    cur = nxt
  }
}

/** Moves `active` within a multi-cell selection on Tab (`across`) or Enter (`down`), wrapping inside the range. */
export function moveWithinSelection(
  ranges: Range[],
  active: Pos,
  mode: 'tab' | 'enter',
  reverse: boolean,
): Pos | null {
  if (rangeCellCount(ranges) <= 1) return null
  const rIdx = ranges.findIndex((r) => rangeContains(r, active))
  const range = rIdx >= 0 ? ranges[rIdx]! : ranges[ranges.length - 1]!

  if (mode === 'tab') {
    const dc = reverse ? -1 : 1
    let row = active.row
    let col = active.col + dc
    if (col > range.right) {
      col = range.left
      row++
    } else if (col < range.left) {
      col = range.right
      row--
    }
    if (row > range.bottom) {
      const nextR = ranges[(rIdx + 1) % ranges.length]!
      return { row: nextR.top, col: nextR.left }
    }
    if (row < range.top) {
      const prevR = ranges[(rIdx - 1 + ranges.length) % ranges.length]!
      return { row: prevR.bottom, col: prevR.right }
    }
    return { row, col }
  }

  const dr = reverse ? -1 : 1
  let row = active.row + dr
  let col = active.col
  if (row > range.bottom) {
    row = range.top
    col++
  } else if (row < range.top) {
    row = range.bottom
    col--
  }
  if (col > range.right) {
    const nextR = ranges[(rIdx + 1) % ranges.length]!
    return { row: nextR.top, col: nextR.left }
  }
  if (col < range.left) {
    const prevR = ranges[(rIdx - 1 + ranges.length) % ranges.length]!
    return { row: prevR.bottom, col: prevR.right }
  }
  return { row, col }
}

/** Excel `Ctrl+A`: current region first (if non-trivial and not already selected), then whole sheet. */
export function ctrlARange(
  data: SheetData | null,
  active: Pos,
  currentSel: Range,
  rows: number,
  cols: number,
): Range {
  const full: Range = { top: 0, left: 0, bottom: rows - 1, right: cols - 1 }
  if (!data) return full
  const region = currentRegion(data, active)
  const singleEmpty =
    region.top === region.bottom &&
    region.left === region.right &&
    !isFilled(data, region.top, region.left)
  if (singleEmpty || sameRange(currentSel, region)) return full
  return region
}

/** First/last visible row or column along an axis (for used-extent End navigation). */
export function usedEndPos(data: SheetData | null): Pos {
  if (!data || data.maxRow < 0 || data.maxCol < 0) return { row: 0, col: 0 }
  return { row: data.maxRow, col: data.maxCol }
}

/**
 * A selection held while Tab/Enter move the active cell inside it (Excel
 * keeps the range and moves only the active cell). It counts only while the
 * active cell and anchor are still where that move put them.
 */
export type HeldSelection = { range: Range; active: Pos; anchor: Pos }

const samePos = (a: Pos, b: Pos) => a.row === b.row && a.col === b.col

/** The selected rectangle: the held one, else the box from the anchor to the active cell. */
export function selectionOf(active: Pos, anchor: Pos, held: HeldSelection | null): Range {
  if (held && samePos(held.active, active) && samePos(held.anchor, anchor)) return held.range
  return {
    top: Math.min(active.row, anchor.row),
    bottom: Math.max(active.row, anchor.row),
    left: Math.min(active.col, anchor.col),
    right: Math.max(active.col, anchor.col),
  }
}
