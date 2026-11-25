import type { SheetEditor } from './editor'
import { readCellImages } from './cell-images'
import { describeCharts } from './chart-ops'
import {
  anchorBox,
  readDrawing,
  sheetGeometry,
  type Anchor,
  type Box,
  type DrawingKind,
} from './drawing'
import { autoFilterOf, describeAutoFilter } from './filter'
import { displayValue, formatCode, type SheetLocale } from './format'
import { styleSummary, type StyleSummary } from './format-cells'
import { readNotes } from './notes'
import { toShownFormula } from './ops'
import { frozenOf } from './panes'
import { pivotSummary, readSheetPivots } from './pivot'
import { sheetProtectionOf } from './protection'
import { cellKey, cellName, rangeName, requireRange, type Range } from './ref'
import { readSheetTables, tableSummary } from './tables'
import { readThreads } from './threads'
import { isErrorValue, XlsxError, type CellValue } from './workbook'

/**
 * Reading a workbook as data (drive.sheet_read, the agent's text): the
 * sheets with their used ranges, and the cells of a range with their values
 * (calculated), formulas, shown text and number format.
 */

export type SheetChartRef = {
  id: string
  name: string
  types: string[]
  title: string | null
  position: string | null
}

export type SheetSummary = {
  name: string
  kind: string
  hidden: boolean
  used: string | null
  /** The sheet's AutoFilter (range, filtered columns), when it has one. */
  filter?: ReturnType<typeof describeAutoFilter>
  /** Frozen panes (rows from the top, columns from the left), when it has them. */
  frozen?: { rows: number; columns: number }
  /** Whether the sheet is protected. */
  protected?: true
  /** Excel tables on this sheet, when it has any. */
  tables?: Array<ReturnType<typeof tableSummary>>
  /** Pivot tables on this sheet, when it has any. */
  pivots?: Array<ReturnType<typeof pivotSummary>>
  /** Charts on this sheet, when it has any. */
  charts?: SheetChartRef[]
  drawings?: number
  notes?: number
  comments?: number
  cell_images?: number
}

export type ReadDrawing = {
  id: string
  kind: DrawingKind
  name: string
  alt: string
  hidden: boolean
  rotation: number
  anchor_cell: string | null
  box: Box
  geometry?: string | null
  fill?: string | null
  line?: {
    color: string
    width_px: number
    dash: boolean
    arrow_start: boolean
    arrow_end: boolean
  } | null
  text?: string
  image?: { part: string; content_type: string } | null
}

export type ReadNote = { ref: string; author: string; text: string; visible: boolean }

export type ReadThread = {
  id: string
  ref: string
  resolved: boolean
  comments: Array<{
    id: string
    author: string
    author_id: string | null
    at: string
    text: string
    mentions: Array<{ name: string; member_id: string | null; start: number; length: number }>
  }>
}

export type ReadCellImage = { ref: string; content_type: string; alt: string }

export type ReadCell = {
  ref: string
  /** The value: a number, text, true/false, or { error: "#DIV/0!" }. */
  value: CellValue
  /** The formula with "=", when the cell has one. */
  formula?: string
  /** As the cell shows it (its number format applied). */
  text: string
  /** The number format code, when not General. */
  format?: string
  /** Font, fill, borders, alignment: only what differs from the workbook's plain format. */
  style?: StyleSummary
  /** The value is Excel's last calculated one: this editor can't calculate the formula (why). */
  kept?: string
}

export function sheetSummaries(ed: SheetEditor): SheetSummary[] {
  return ed.wb.sheets().map((s) => {
    const used = s.kind === 'worksheet' ? usedRange(ed, s.name) : null
    const out: SheetSummary = {
      name: s.name,
      kind: s.kind === 'worksheet' ? 'sheet' : s.kind,
      hidden: s.state !== 'visible',
      used: used ? rangeName(used) : null,
    }
    const charts = describeCharts(ed.wb, s.name)
    if (charts.length > 0)
      out.charts = charts.map((c) => ({
        id: c.id,
        name: c.name,
        types: c.types,
        title: c.title,
        position: c.position,
      }))
    if (s.kind !== 'worksheet') return out
    const af = autoFilterOf(ed.wb, s.name)
    if (af) out.filter = describeAutoFilter(af)
    const frozen = frozenOf(ed.wb, s.name)
    if (frozen) out.frozen = { rows: frozen.rows, columns: frozen.cols }
    // Charts are listed under `charts`; `drawings` counts the other objects.
    const drawings = readDrawing(ed.wb, s).filter((o) => o.kind !== 'chart').length
    if (drawings > 0) out.drawings = drawings
    const notes = readNotes(ed.wb, s).length
    if (notes > 0) out.notes = notes
    const comments = readThreads(ed.wb, s).length
    if (comments > 0) out.comments = comments
    const cellImages = readCellImages(ed.wb, s).length
    if (cellImages > 0) out.cell_images = cellImages
    if (sheetProtectionOf(ed.wb, s.name)) out.protected = true
    const tables = readSheetTables(ed.wb, s.name)
    if (tables.length > 0) out.tables = tables.map(tableSummary)
    const pivots = readSheetPivots(ed.wb, s.name)
    if (pivots.length > 0) out.pivots = pivots.map(pivotSummary)
    return out
  })
}

function anchorCell(a: Anchor | null): string | null {
  if (!a || a.type === 'absolute') return null
  const from = cellName({ row: a.from.row, col: a.from.col })
  if (a.type === 'oneCell') return from
  const to = cellName({ row: a.to.row, col: a.to.col })
  return to === from ? from : `${from}:${to}`
}

/** Drawings, notes, threaded comments and in-cell images of one worksheet. */
export function readSheetAnnotations(
  ed: SheetEditor,
  sheet: string,
): {
  drawings: ReadDrawing[]
  notes: ReadNote[]
  comments: ReadThread[]
  cell_images: ReadCellImage[]
} {
  const info = ed.wb.requireWorksheet(sheet)
  const g = sheetGeometry(ed.wb.sheet(info.name))
  // Charts have their own description (drive.sheet_chart_list, `charts` in drive.sheet_read).
  const drawings: ReadDrawing[] = readDrawing(ed.wb, info, g).filter((o) => o.kind !== 'chart').map((o) => {
    const out: ReadDrawing = {
      id: o.id,
      kind: o.kind,
      name: o.name,
      alt: o.alt,
      hidden: o.hidden,
      rotation: o.rotation,
      anchor_cell: anchorCell(o.anchor),
      box: o.anchor ? anchorBox(o.anchor, g) : { x: 0, y: 0, w: 0, h: 0 },
    }
    if (o.geometry !== undefined) out.geometry = o.geometry
    if (o.fill !== undefined) out.fill = o.fill
    if (o.line !== undefined)
      out.line = o.line
        ? {
            color: o.line.color,
            width_px: o.line.widthPx,
            dash: o.line.dash,
            arrow_start: o.line.arrowStart,
            arrow_end: o.line.arrowEnd,
          }
        : null
    if (o.text !== undefined) out.text = o.text
    if (o.image !== undefined)
      out.image = o.image ? { part: o.image.part, content_type: o.image.contentType } : null
    return out
  })
  const notes: ReadNote[] = readNotes(ed.wb, info).map((n) => ({
    ref: n.ref,
    author: n.author,
    text: n.text,
    visible: n.visible,
  }))
  const comments: ReadThread[] = readThreads(ed.wb, info).map((t) => ({
    id: t.id,
    ref: t.ref,
    resolved: t.resolved,
    comments: t.comments.map((c) => ({
      id: c.id,
      author: c.author,
      author_id: c.authorId,
      at: c.at,
      text: c.text,
      mentions: c.mentions.map((m) => ({
        name: m.name,
        member_id: m.memberId,
        start: m.start,
        length: m.length,
      })),
    })),
  }))
  const cell_images: ReadCellImage[] = readCellImages(ed.wb, info).map((ci) => ({
    ref: ci.ref,
    content_type: ci.contentType,
    alt: ci.alt,
  }))
  return { drawings, notes, comments, cell_images }
}

export function usedRange(ed: SheetEditor, sheet: string): Range | null {
  const d = ed.wb.sheet(sheet)
  let bottom = d.maxRow
  let right = d.maxCol
  // Dynamic arrays can spill past the cells the file has.
  for (const sp of ed.calc().spills(d.info.name)) {
    bottom = Math.max(bottom, sp.range.bottom)
    right = Math.max(right, sp.range.right)
  }
  return bottom < 0 ? null : { top: 0, left: 0, bottom, right }
}

/** Cells a dynamic array spilled into that the file does not have yet (shown like filled cells). */
function spilledCells(ed: SheetEditor, sheet: string, range: Range) {
  const data = ed.wb.sheet(sheet)
  const out: Array<{ row: number; col: number; style: number; formula: null }> = []
  for (const sp of ed.calc().spills(sheet)) {
    const r = sp.range
    for (let row = Math.max(r.top, range.top); row <= Math.min(r.bottom, range.bottom); row++)
      for (let col = Math.max(r.left, range.left); col <= Math.min(r.right, range.right); col++) {
        const c = data.cells.get(cellKey(row, col))
        if (!c || (c.value === null && c.formula === null))
          out.push({ row, col, style: c?.style ?? 0, formula: null })
      }
  }
  return out
}

/** The non-empty cells of `range` (null: the used range), row by row. At most `max` cells; a larger range is refused, never cut. */
export function readCells(
  ed: SheetEditor,
  sheet: string,
  rangeText: string | null,
  locale: SheetLocale,
  max: number,
): { range: string | null; cells: ReadCell[] } {
  const info = ed.wb.requireWorksheet(sheet)
  const range = rangeText ? requireRange(rangeText) : usedRange(ed, info.name)
  if (!range) return { range: null, cells: [] }
  const data = ed.wb.sheet(info.name)
  const styles = ed.wb.styles()
  const calc = ed.calc()
  const picked: Array<{ row: number; col: number; style: number; formula: string | null }> = [
    ...[...data.cells.values()].filter(
      (c) =>
        c.row >= range.top &&
        c.row <= range.bottom &&
        c.col >= range.left &&
        c.col <= range.right &&
        (c.value !== null || c.formula !== null),
    ),
    ...spilledCells(ed, info.name, range),
  ].sort((a, b) => a.row - b.row || a.col - b.col)
  if (picked.length > max)
    throw new XlsxError(
      `${info.name}!${rangeName(range)} has ${picked.length} filled cells; read at most ${max} at a time (ask for a smaller range).`,
    )
  return {
    range: rangeName(range),
    cells: picked.map((c) => {
      const out = calc.cell(info.name, c.row, c.col)
      const st = styles.xf(c.style)
      const code = formatCode(st.numFmtId, st.numFmt, locale)
      const cell: ReadCell = {
        ref: cellName(c),
        value: out.value,
        text: displayValue(out.value, code, locale, { date1904: ed.wb.date1904 }).text,
      }
      if (c.formula !== null) cell.formula = `=${toShownFormula(c.formula)}`
      if (st.numFmt !== 'General') cell.format = st.numFmt
      const look = styleSummary(st, styles.xf(0))
      if (look) cell.style = look
      if (out.kept) cell.kept = out.reason
      return cell
    }),
  }
}

/** The shown text of every cell of `range` (null: the used range) as rows, for tables. */
export function sheetValues(
  ed: SheetEditor,
  sheet: string,
  rangeText: string | null,
  locale: SheetLocale,
): { range: string | null; rows: string[][] } {
  const info = ed.wb.requireWorksheet(sheet)
  const range = rangeText ? requireRange(rangeText) : usedRange(ed, info.name)
  if (!range) return { range: null, rows: [] }
  const data = ed.wb.sheet(info.name)
  const styles = ed.wb.styles()
  const calc = ed.calc()
  const rows: string[][] = []
  for (let r = range.top; r <= range.bottom; r++) {
    const row: string[] = []
    for (let c = range.left; c <= range.right; c++) {
      const cell = data.cells.get(cellKey(r, c))
      const v = calc.cell(info.name, r, c).value
      if (!cell && v === null) {
        row.push('')
        continue
      }
      const st = styles.xf(cell?.style ?? 0)
      row.push(
        isErrorValue(v)
          ? v.error
          : displayValue(v, formatCode(st.numFmtId, st.numFmt, locale), locale, {
              date1904: ed.wb.date1904,
            }).text,
      )
    }
    rows.push(row)
  }
  return { range: rangeName(range), rows }
}
