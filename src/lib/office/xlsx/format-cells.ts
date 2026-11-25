import type { CellStyle } from './styles'
import { finishSheet, restyle, sheetDoc, stylesDoc, type OpResult } from './ops'
import { cellKey, colName, MAX_COLS, MAX_ROWS, rangeName, requireRange, type Range } from './ref'
import { dropEmptyRow, ensureRow, findRow } from './sheet-xml'
import {
  BORDER_PRESETS,
  BORDER_STYLES,
  HORIZONTAL,
  VERTICAL,
  type BorderPreset,
  type BorderStyle,
  type Horizontal,
  type Vertical,
} from './style-choices'
import { xfWithPatch, type EdgeWrite, type Side, type XfPatch } from './style-records'
import { XlsxError, type SheetData, type Workbook } from './workbook'
import { kid, kids, make } from './xml'

/**
 * Cell formatting and sizing as operations (the grid's format toolbar, the
 * column/row drag handles and drive.sheet_format make the same ones): fonts,
 * fills, borders and alignment on a range, written as copies of each cell's
 * format record (./style-records.ts); column widths as `<cols>` entries and
 * row heights as `<row ht customHeight>`. Everything else about the cells,
 * the sheet and the other parts stays as it was.
 */

/** What to change about the cells' look; whatever is left out stays as it is per cell. */
export type StylePatch = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** Points. */
  fontSize?: number
  /** "#RRGGBB"; null: automatic. */
  fontColor?: string | null
  fontName?: string
  /** A solid background "#RRGGBB"; null: none. */
  fill?: string | null
  /** null or "general": Excel's default (text left, numbers right). */
  horizontal?: Horizontal | null
  /** null or "bottom": Excel's default. */
  vertical?: Vertical | null
  wrap?: boolean
  /** Lines around and inside the range (style default thin, colour default automatic); "none" removes them. */
  border?: { preset: BorderPreset; style?: BorderStyle; color?: string | null }
}

export type FormatOp =
  | { op: 'set_style'; sheet: string; range: string; style: StylePatch }
  /** Columns `from`…`to` (from 0); width in Excel's characters, null: back to the sheet's default. */
  | { op: 'set_column_width'; sheet: string; from: number; to: number; width: number | null }
  /** Rows `from`…`to` (from 0); height in points, null: back to the automatic height. */
  | { op: 'set_row_height'; sheet: string; from: number; to: number; height: number | null }

export const MAX_STYLE_CELLS = 100_000
export const MAX_SIZE_ROWS = 10_000
export const MAX_COL_WIDTH = 255
export const MAX_ROW_HEIGHT = 409
/** Calibri 11's maximum digit width, the unit widths are measured in (as ./workbook.ts reads them). */
const MAX_DIGIT_PX = 7

export function runFormatOp(wb: Workbook, op: FormatOp): OpResult {
  switch (op.op) {
    case 'set_style':
      return setStyle(wb, op.sheet, op.range, op.style)
    case 'set_column_width':
      return setColumnWidth(wb, op.sheet, op.from, op.to, op.width)
    case 'set_row_height':
      return setRowHeight(wb, op.sheet, op.from, op.to, op.height)
  }
}

/** The edges `preset` writes on cell (r, c) of `range`. */
function edgesFor(
  border: NonNullable<StylePatch['border']>,
  range: Range,
  r: number,
  c: number,
): Partial<Record<Side, EdgeWrite>> {
  const line: EdgeWrite =
    border.preset === 'none' ? null : { style: border.style ?? 'thin', color: border.color ?? null }
  const out: Partial<Record<Side, EdgeWrite>> = {}
  const put = (side: Side, when: boolean) => {
    if (when) out[side] = line
  }
  const { top, bottom, left, right } = range
  switch (border.preset) {
    case 'all':
    case 'none':
      for (const s of ['left', 'right', 'top', 'bottom'] as const) out[s] = line
      break
    case 'outer':
      put('top', r === top)
      put('bottom', r === bottom)
      put('left', c === left)
      put('right', c === right)
      break
    case 'inner':
      put('top', r > top)
      put('bottom', r < bottom)
      put('left', c > left)
      put('right', c < right)
      break
    case 'top':
      put('top', r === top)
      break
    case 'bottom':
      put('bottom', r === bottom)
      break
    case 'left':
      put('left', c === left)
      break
    case 'right':
      put('right', c === right)
      break
  }
  return out
}

function checkPatch(p: StylePatch) {
  const keys = Object.keys(p).filter((k) => p[k as keyof StylePatch] !== undefined)
  if (keys.length === 0) throw new XlsxError('Nothing to format: give at least one style.')
  if (p.border) {
    if (!BORDER_PRESETS.includes(p.border.preset))
      throw new XlsxError(
        `“${p.border.preset}” is not a border choice (${BORDER_PRESETS.join(', ')}).`,
      )
    if (p.border.style !== undefined && !BORDER_STYLES.includes(p.border.style))
      throw new XlsxError(`“${p.border.style}” is not a border style.`)
  }
  if (p.horizontal != null && !HORIZONTAL.includes(p.horizontal))
    throw new XlsxError(`“${p.horizontal}” is not a horizontal alignment.`)
  if (p.vertical != null && !VERTICAL.includes(p.vertical))
    throw new XlsxError(`“${p.vertical}” is not a vertical alignment.`)
}

function setStyle(wb: Workbook, sheet: string, rangeText: string, patch: StylePatch): OpResult {
  const info = wb.requireWorksheet(sheet)
  const range = requireRange(rangeText)
  const n = (range.bottom - range.top + 1) * (range.right - range.left + 1)
  if (n > MAX_STYLE_CELLS)
    throw new XlsxError(
      `${rangeName(range)} is ${n} cells; format at most ${MAX_STYLE_CELLS} at a time.`,
    )
  checkPatch(patch)
  const font: XfPatch['font'] = {}
  if (patch.bold !== undefined) font.bold = patch.bold
  if (patch.italic !== undefined) font.italic = patch.italic
  if (patch.underline !== undefined) font.underline = patch.underline
  if (patch.strike !== undefined) font.strike = patch.strike
  if (patch.fontSize !== undefined) font.sizePt = patch.fontSize
  if (patch.fontColor !== undefined) font.color = patch.fontColor
  if (patch.fontName !== undefined) font.name = patch.fontName
  const base: XfPatch = { font }
  if (patch.fill !== undefined) base.fill = patch.fill
  if (patch.horizontal !== undefined) base.horizontal = patch.horizontal
  if (patch.vertical !== undefined) base.vertical = patch.vertical
  if (patch.wrap !== undefined) base.wrap = patch.wrap
  const data = wb.sheet(info.name)
  const doc = sheetDoc(wb, info)
  const sdoc = stylesDoc(wb)
  const memo = new Map<string, number>()
  for (let r = range.top; r <= range.bottom; r++) {
    for (let c = range.left; c <= range.right; c++) {
      const cur = data.cells.get(cellKey(r, c))?.style ?? 0
      const edges = patch.border ? edgesFor(patch.border, range, r, c) : {}
      const key = `${cur}|${Object.keys(edges).sort().join(',')}`
      let next = memo.get(key)
      if (next === undefined) {
        next = xfWithPatch(sdoc, cur, { ...base, border: edges })
        memo.set(key, next)
      }
      if (next !== cur) restyle(wb, doc, r, c, next)
    }
  }
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

function checkSpan(what: 'column' | 'row', from: number, to: number) {
  const limit = what === 'column' ? MAX_COLS : MAX_ROWS
  const name = (i: number) => (what === 'column' ? colName(i) : String(i + 1))
  for (const i of [from, to])
    if (!Number.isInteger(i) || i < 0 || i >= limit)
      throw new XlsxError(`${what === 'column' ? 'Column' : 'Row'} ${i + 1} is outside the sheet.`)
  if (to < from) throw new XlsxError(`The ${what}s run from ${name(from)} back to ${name(to)}.`)
}

/** The sheet's default column width in characters (sheetFormatPr, else Excel's 8.43 at the base width). */
function defaultWidth(root: Element): number {
  const fmt = kid(root, 'sheetFormatPr')
  const def = fmt?.getAttribute('defaultColWidth')
  if (def) return Number(def)
  const baseW = fmt?.getAttribute('baseColWidth')
  // §18.3.1.81: the base width in characters plus 5 px of padding, in 1/256 characters.
  const chars = baseW ? Number(baseW) : 8
  return Math.trunc(((chars * MAX_DIGIT_PX + 5) / MAX_DIGIT_PX) * 256) / 256
}

/** Column `<col>` attributes that say something besides the width. */
const COL_KEEPS = ['style', 'hidden', 'outlineLevel', 'collapsed', 'phonetic']

function setColumnWidth(
  wb: Workbook,
  sheet: string,
  from: number,
  to: number,
  width: number | null,
): OpResult {
  const info = wb.requireWorksheet(sheet)
  checkSpan('column', from, to)
  if (width !== null && !(width > 0 && width <= MAX_COL_WIDTH))
    throw new XlsxError(`A column is 0 to ${MAX_COL_WIDTH} characters wide (${width} given).`)
  const doc = sheetDoc(wb, info)
  const root = doc.documentElement!
  let colsEl = kid(root, 'cols')
  if (!colsEl) {
    if (width === null) return { sheets: [] }
    colsEl = make(doc, 'cols')
    root.insertBefore(colsEl, kid(root, 'sheetData'))
  }
  const lo = from + 1
  const hi = to + 1
  const sized = (el: Element) => {
    if (width !== null) {
      el.setAttribute('width', String(width))
      el.setAttribute('customWidth', '1')
      // A width shows the column again (as dragging its edge does in Excel).
      el.removeAttribute('hidden')
      return el
    }
    el.removeAttribute('customWidth')
    el.removeAttribute('bestFit')
    if (!COL_KEEPS.some((a) => el.hasAttribute(a))) return null
    el.setAttribute('width', String(defaultWidth(root)))
    return el
  }
  const piece = (src: Element, min: number, max: number) => {
    const el = src.cloneNode(true) as Element
    el.setAttribute('min', String(min))
    el.setAttribute('max', String(max))
    return el
  }
  // Entries outside the span stay as they are; one that overlaps it is split.
  const out: Element[] = []
  let covered = lo
  const fresh = (min: number, max: number) => {
    if (width === null || min > max) return
    const el = make(doc, 'col')
    el.setAttribute('min', String(min))
    el.setAttribute('max', String(max))
    out.push(sized(el)!)
  }
  for (const col of kids(colsEl, 'col')) {
    const min = Number(col.getAttribute('min'))
    const max = Number(col.getAttribute('max'))
    if (max < lo || min > hi) {
      if (min > hi && covered <= hi) {
        fresh(covered, hi)
        covered = hi + 1
      }
      out.push(col)
      continue
    }
    if (min < lo) out.push(piece(col, min, lo - 1))
    const a = Math.max(min, lo)
    const b = Math.min(max, hi)
    fresh(covered, a - 1)
    const mid = sized(piece(col, a, b))
    if (mid) out.push(mid)
    covered = b + 1
    if (max > hi) out.push(piece(col, hi + 1, max))
  }
  if (covered <= hi) fresh(covered, hi)
  out.sort((x, y) => Number(x.getAttribute('min')) - Number(y.getAttribute('min')))
  for (const k of kids(colsEl, 'col')) colsEl.removeChild(k)
  for (const el of out) colsEl.appendChild(el)
  if (out.length === 0) root.removeChild(colsEl)
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

function setRowHeight(
  wb: Workbook,
  sheet: string,
  from: number,
  to: number,
  height: number | null,
): OpResult {
  const info = wb.requireWorksheet(sheet)
  checkSpan('row', from, to)
  if (to - from + 1 > MAX_SIZE_ROWS)
    throw new XlsxError(`Size at most ${MAX_SIZE_ROWS} rows at a time.`)
  if (height !== null && !(height > 0 && height <= MAX_ROW_HEIGHT))
    throw new XlsxError(`A row is 0 to ${MAX_ROW_HEIGHT} points high (${height} given).`)
  const doc = sheetDoc(wb, info)
  for (let r = from; r <= to; r++) {
    if (height !== null) {
      const el = ensureRow(doc, r)
      el.setAttribute('ht', String(height))
      el.setAttribute('customHeight', '1')
      el.removeAttribute('hidden')
      continue
    }
    const el = findRow(doc, r)
    if (!el) continue
    el.removeAttribute('ht')
    el.removeAttribute('customHeight')
    dropEmptyRow(el)
  }
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

// ---------------------------------------------------------------------------
// Reading (drive.sheet_read): the look of a cell, and the sheet's own sizes

/** A cell's look as the tools report it: only what differs from the workbook's plain format. */
export type StyleSummary = {
  bold?: true
  italic?: true
  underline?: true
  strike?: true
  font_size?: number
  font_color?: string
  font_name?: string
  fill?: string
  horizontal?: string
  vertical?: string
  wrap?: true
  /** Per edge: "thin", "medium #C00000" … */
  border?: Partial<Record<Side, string>>
}

export function styleSummary(st: CellStyle, plain: CellStyle): StyleSummary | null {
  const out: StyleSummary = {}
  if (st.font.bold) out.bold = true
  if (st.font.italic) out.italic = true
  if (st.font.underline) out.underline = true
  if (st.font.strike) out.strike = true
  if (st.font.sizePt !== null && st.font.sizePt !== plain.font.sizePt)
    out.font_size = st.font.sizePt
  if (st.font.color && st.font.color !== plain.font.color) out.font_color = st.font.color
  if (st.font.name && st.font.name !== plain.font.name) out.font_name = st.font.name
  if (st.fill) out.fill = st.fill
  if (st.horizontal && st.horizontal !== 'general') out.horizontal = st.horizontal
  if (st.vertical && st.vertical !== 'bottom') out.vertical = st.vertical
  if (st.wrap) out.wrap = true
  const border: Partial<Record<Side, string>> = {}
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const e = st.border[side]
    if (e) border[side] = e.color ? `${e.style} ${e.color}` : e.style
  }
  if (Object.keys(border).length > 0) out.border = border
  return Object.keys(out).length > 0 ? out : null
}

export type SheetSizes = {
  /** Columns with their own width (Excel characters), "B" or "B:D". */
  columns: Array<{ columns: string; width: number; hidden?: true }>
  /** Rows with their own height (points). */
  rows: Array<{ row: number; height: number; hidden?: true }>
}

/** The column widths and row heights `range` touches that differ from the sheet's default. */
export function sheetSizes(wb: Workbook, data: SheetData, range: Range | null): SheetSizes {
  const root = wb.pkg.xml(data.info.part).documentElement!
  const colsEl = kid(root, 'cols')
  const columns: SheetSizes['columns'] = []
  for (const col of colsEl ? kids(colsEl, 'col') : []) {
    const min = Number(col.getAttribute('min')) - 1
    const max = Number(col.getAttribute('max')) - 1
    if (range && (max < range.left || min > range.right)) continue
    const w = col.getAttribute('width')
    const hidden = col.getAttribute('hidden') === '1' || col.getAttribute('hidden') === 'true'
    if (w === null && !hidden) continue
    const name = min === max ? colName(min) : `${colName(min)}:${colName(max)}`
    columns.push({ columns: name, width: Number(w ?? 0), ...(hidden ? { hidden: true } : {}) })
  }
  const rows: SheetSizes['rows'] = []
  const sheetData = kid(root, 'sheetData')
  for (const el of sheetData ? kids(sheetData, 'row') : []) {
    const r = Number(el.getAttribute('r')) - 1
    if (range && (r < range.top || r > range.bottom)) continue
    const ht = el.getAttribute('ht')
    const custom =
      el.getAttribute('customHeight') === '1' || el.getAttribute('customHeight') === 'true'
    const hidden = el.getAttribute('hidden') === '1' || el.getAttribute('hidden') === 'true'
    if ((!ht || !custom) && !hidden) continue
    rows.push({ row: r + 1, height: Number(ht ?? 0), ...(hidden ? { hidden: true } : {}) })
  }
  return { columns, rows }
}
