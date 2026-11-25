import type { SheetLocale } from './format'
import type { OpResult } from './ops'
import { createCalc } from './calc'
import { displayValue, formatCode } from './format'
import { colName, MAX_COLS, MAX_ROWS } from './ref'
import { finishSheet, setSheetRowColOp } from './rows-cols-helpers'
import { WORKSHEET_ORDER } from './sheet-order'
import { dropEmptyRow, ensureRow, findRow } from './sheet-xml'
import { XlsxError, type Workbook } from './workbook'
import { insertInOrder, kid, kids, make } from './xml'

/**
 * Row and column hide/unhide, outline grouping + collapse/expand, and autofit
 * width/height on double-click or tool call (ECMA-376 Part 1 §18.3.1.13 col,
 * §18.3.1.73 row, §18.3.1.82 sheetFormatPr, §18.3.1.63 outlinePr).
 */

export type RowsColsOp =
  | { op: 'hide_columns'; sheet: string; from: number; to: number; hidden: boolean }
  | { op: 'hide_rows'; sheet: string; from: number; to: number; hidden: boolean }
  | { op: 'group_columns'; sheet: string; from: number; to: number }
  | { op: 'ungroup_columns'; sheet: string; from: number; to: number }
  | { op: 'group_rows'; sheet: string; from: number; to: number }
  | { op: 'ungroup_rows'; sheet: string; from: number; to: number }
  | { op: 'collapse_columns'; sheet: string; from: number; to: number; collapsed: boolean }
  | { op: 'collapse_rows'; sheet: string; from: number; to: number; collapsed: boolean }
  | { op: 'set_outline_level'; sheet: string; axis: 'row' | 'col'; level: number }
  | { op: 'autofit_columns'; sheet: string; from: number; to: number; locale?: SheetLocale }
  | { op: 'autofit_rows'; sheet: string; from: number; to: number; locale?: SheetLocale }

export const MAX_OUTLINE_LEVEL = 7
const MAX_DIGIT_PX = 7

export type OutlineGroup = {
  from: number
  to: number
  level: number
  collapsed: boolean
  summaryAt: number
}

export type SheetOutline = {
  rows: OutlineGroup[]
  cols: OutlineGroup[]
  maxRowLevel: number
  maxColLevel: number
  summaryBelow: boolean
  summaryRight: boolean
}

function checkSpan(axis: 'row' | 'col', from: number, to: number) {
  const limit = axis === 'col' ? MAX_COLS : MAX_ROWS
  const name = (i: number) => (axis === 'col' ? colName(i) : String(i + 1))
  for (const i of [from, to])
    if (!Number.isInteger(i) || i < 0 || i >= limit)
      throw new XlsxError(`${axis === 'col' ? 'Column' : 'Row'} ${i + 1} is outside the sheet.`)
  if (to < from)
    throw new XlsxError(
      `The ${axis === 'col' ? 'columns' : 'rows'} run from ${name(from)} back to ${name(to)}.`,
    )
}

function boolAttr(el: Element | null, attr: string, fallback: boolean): boolean {
  if (!el || !el.hasAttribute(attr)) return fallback
  const v = el.getAttribute(attr)
  return v === '1' || v === 'true'
}

function groupsFromLevels(
  levels: Map<number, number>,
  hidden: Set<number>,
  collapsedAt: Set<number>,
  summaryAfter: boolean,
): { groups: OutlineGroup[]; maxLevel: number } {
  let maxLevel = 0
  for (const l of levels.values()) if (l > maxLevel) maxLevel = l
  if (maxLevel === 0) return { groups: [], maxLevel: 0 }
  const groups: OutlineGroup[] = []
  const indices = [...levels.keys()].sort((a, b) => a - b)
  for (let level = 1; level <= maxLevel; level++) {
    let start: number | null = null
    let prev = -2
    const flush = (end: number) => {
      if (start === null) return
      const summaryAt = summaryAfter ? end + 1 : start - 1
      let allHidden = true
      for (let i = start; i <= end; i++) {
        if (!hidden.has(i)) {
          allHidden = false
          break
        }
      }
      groups.push({
        from: start,
        to: end,
        level,
        collapsed: collapsedAt.has(summaryAt) || allHidden,
        summaryAt,
      })
      start = null
    }
    for (const i of indices) {
      if ((levels.get(i) ?? 0) < level) continue
      if (start === null) {
        start = i
        prev = i
      } else if (i === prev + 1) {
        prev = i
      } else {
        flush(prev)
        start = i
        prev = i
      }
    }
    flush(prev)
  }
  return { groups, maxLevel }
}

/** Reads row & column outline groups and summary placement from a worksheet. */
export function outlineOf(wb: Workbook, sheet: string): SheetOutline {
  const info = wb.requireWorksheet(sheet)
  const root = wb.pkg.xml(info.part).documentElement!
  const sheetPr = kid(root, 'sheetPr')
  const outlinePr = sheetPr ? kid(sheetPr, 'outlinePr') : null
  const summaryBelow = boolAttr(outlinePr, 'summaryBelow', true)
  const summaryRight = boolAttr(outlinePr, 'summaryRight', true)

  const rowLevels = new Map<number, number>()
  const rowHidden = new Set<number>()
  const rowCollapsed = new Set<number>()
  const sheetData = kid(root, 'sheetData')
  for (const el of sheetData ? kids(sheetData, 'row') : []) {
    const r = Number(el.getAttribute('r')) - 1
    if (r < 0) continue
    const ol = Number(el.getAttribute('outlineLevel') ?? 0)
    if (ol > 0) rowLevels.set(r, ol)
    if (boolAttr(el, 'hidden', false)) rowHidden.add(r)
    if (boolAttr(el, 'collapsed', false)) rowCollapsed.add(r)
  }

  const colLevels = new Map<number, number>()
  const colHidden = new Set<number>()
  const colCollapsed = new Set<number>()
  const colsEl = kid(root, 'cols')
  for (const el of colsEl ? kids(colsEl, 'col') : []) {
    const min = Number(el.getAttribute('min')) - 1
    const max = Number(el.getAttribute('max')) - 1
    const ol = Number(el.getAttribute('outlineLevel') ?? 0)
    const hid = boolAttr(el, 'hidden', false)
    const colap = boolAttr(el, 'collapsed', false)
    for (let c = min; c <= max; c++) {
      if (ol > 0) colLevels.set(c, ol)
      if (hid) colHidden.add(c)
      if (colap) colCollapsed.add(c)
    }
  }

  const rOut = groupsFromLevels(rowLevels, rowHidden, rowCollapsed, summaryBelow)
  const cOut = groupsFromLevels(colLevels, colHidden, colCollapsed, summaryRight)
  return {
    rows: rOut.groups,
    cols: cOut.groups,
    maxRowLevel: rOut.maxLevel,
    maxColLevel: cOut.maxLevel,
    summaryBelow,
    summaryRight,
  }
}

function defaultWidth(root: Element): number {
  const fmt = kid(root, 'sheetFormatPr')
  const def = fmt?.getAttribute('defaultColWidth')
  if (def) return Number(def)
  const baseW = fmt?.getAttribute('baseColWidth')
  const chars = baseW ? Number(baseW) : 8
  return Math.trunc(((chars * MAX_DIGIT_PX + 5) / MAX_DIGIT_PX) * 256) / 256
}

const COL_KEEP_CHECK = ['style', 'hidden', 'outlineLevel', 'collapsed', 'phonetic', 'customWidth']

function mutateCols(
  doc: XMLDocument,
  from: number,
  to: number,
  mutator: (el: Element, isNew: boolean) => boolean,
) {
  const root = doc.documentElement!
  let colsEl = kid(root, 'cols')
  if (!colsEl) {
    colsEl = make(doc, 'cols')
    insertInOrder(root, colsEl, WORKSHEET_ORDER)
  }
  const lo = from + 1
  const hi = to + 1
  const piece = (src: Element, min: number, max: number) => {
    const el = src.cloneNode(true) as Element
    el.setAttribute('min', String(min))
    el.setAttribute('max', String(max))
    return el
  }
  const out: Element[] = []
  let covered = lo
  const makeFresh = (min: number, max: number) => {
    if (min > max) return
    const el = make(doc, 'col')
    el.setAttribute('min', String(min))
    el.setAttribute('max', String(max))
    el.setAttribute('width', String(defaultWidth(root)))
    if (mutator(el, true)) out.push(el)
  }
  for (const col of kids(colsEl, 'col')) {
    const min = Number(col.getAttribute('min'))
    const max = Number(col.getAttribute('max'))
    if (max < lo || min > hi) {
      if (min > hi && covered <= hi) {
        makeFresh(covered, hi)
        covered = hi + 1
      }
      out.push(col)
      continue
    }
    if (min < lo) out.push(piece(col, min, lo - 1))
    const a = Math.max(min, lo)
    const b = Math.min(max, hi)
    makeFresh(covered, a - 1)
    const mid = piece(col, a, b)
    if (!mid.hasAttribute('width')) mid.setAttribute('width', String(defaultWidth(root)))
    if (mutator(mid, false) && COL_KEEP_CHECK.some((attr) => mid.hasAttribute(attr))) out.push(mid)
    covered = b + 1
    if (max > hi) out.push(piece(col, hi + 1, max))
  }
  if (covered <= hi) makeFresh(covered, hi)
  out.sort((x, y) => Number(x.getAttribute('min')) - Number(y.getAttribute('min')))
  for (const k of kids(colsEl, 'col')) colsEl.removeChild(k)
  for (const el of out) colsEl.appendChild(el)
  if (out.length === 0) root.removeChild(colsEl)
}

function updateOutlineFormatPr(doc: XMLDocument, axis: 'row' | 'col') {
  const root = doc.documentElement!
  let max = 0
  if (axis === 'row') {
    const sheetData = kid(root, 'sheetData')
    for (const el of sheetData ? kids(sheetData, 'row') : []) {
      const ol = Number(el.getAttribute('outlineLevel') ?? 0)
      if (ol > max) max = ol
    }
  } else {
    const colsEl = kid(root, 'cols')
    for (const el of colsEl ? kids(colsEl, 'col') : []) {
      const ol = Number(el.getAttribute('outlineLevel') ?? 0)
      if (ol > max) max = ol
    }
  }
  let fmt = kid(root, 'sheetFormatPr')
  if (!fmt) {
    if (max === 0) return
    fmt = make(doc, 'sheetFormatPr')
    fmt.setAttribute('defaultRowHeight', '15')
    insertInOrder(root, fmt, WORKSHEET_ORDER)
  }
  const attr = axis === 'row' ? 'outlineLevelRow' : 'outlineLevelCol'
  if (max === 0) fmt.removeAttribute(attr)
  else fmt.setAttribute(attr, String(max))
}

function hideCols(
  wb: Workbook,
  sheet: string,
  from: number,
  to: number,
  hidden: boolean,
): OpResult {
  const info = wb.requireWorksheet(sheet)
  checkSpan('col', from, to)
  const doc = wb.edit(info.part)
  mutateCols(doc, from, to, (el) => {
    if (hidden) {
      el.setAttribute('hidden', '1')
      return true
    }
    el.removeAttribute('hidden')
    return COL_KEEP_CHECK.some((a) => el.hasAttribute(a))
  })
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

function hideRows(
  wb: Workbook,
  sheet: string,
  from: number,
  to: number,
  hidden: boolean,
): OpResult {
  const info = wb.requireWorksheet(sheet)
  checkSpan('row', from, to)
  const doc = wb.edit(info.part)
  for (let r = from; r <= to; r++) {
    if (hidden) {
      ensureRow(doc, r).setAttribute('hidden', '1')
    } else {
      const el = findRow(doc, r)
      if (!el) continue
      el.removeAttribute('hidden')
      dropEmptyRow(el)
    }
  }
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

function groupCols(wb: Workbook, sheet: string, from: number, to: number, delta: 1 | -1): OpResult {
  const info = wb.requireWorksheet(sheet)
  checkSpan('col', from, to)
  const doc = wb.edit(info.part)
  mutateCols(doc, from, to, (el, isNew) => {
    const cur = isNew ? 0 : Number(el.getAttribute('outlineLevel') ?? 0)
    const next = Math.max(0, Math.min(MAX_OUTLINE_LEVEL, cur + delta))
    if (next === 0) {
      el.removeAttribute('outlineLevel')
      el.removeAttribute('collapsed')
    } else {
      el.setAttribute('outlineLevel', String(next))
    }
    return COL_KEEP_CHECK.some((a) => el.hasAttribute(a))
  })
  updateOutlineFormatPr(doc, 'col')
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

function groupRows(wb: Workbook, sheet: string, from: number, to: number, delta: 1 | -1): OpResult {
  const info = wb.requireWorksheet(sheet)
  checkSpan('row', from, to)
  const doc = wb.edit(info.part)
  for (let r = from; r <= to; r++) {
    const cur = Number(findRow(doc, r)?.getAttribute('outlineLevel') ?? 0)
    const next = Math.max(0, Math.min(MAX_OUTLINE_LEVEL, cur + delta))
    if (next === 0) {
      const el = findRow(doc, r)
      if (!el) continue
      el.removeAttribute('outlineLevel')
      el.removeAttribute('collapsed')
      dropEmptyRow(el)
    } else {
      ensureRow(doc, r).setAttribute('outlineLevel', String(next))
    }
  }
  updateOutlineFormatPr(doc, 'row')
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

function collapseCols(
  wb: Workbook,
  sheet: string,
  from: number,
  to: number,
  collapsed: boolean,
): OpResult {
  const info = wb.requireWorksheet(sheet)
  checkSpan('col', from, to)
  const outline = outlineOf(wb, info.name)
  const summaryAt = outline.summaryRight ? to + 1 : from - 1
  const doc = wb.edit(info.part)
  // Keep inner nested collapsed groups hidden when expanding an outer group
  const innerHidden = new Set<number>()
  if (!collapsed) {
    const targetLevel = Math.min(
      ...outline.cols.filter((g) => g.from <= from && g.to >= to).map((g) => g.level),
      1,
    )
    for (const g of outline.cols) {
      if (g.level > targetLevel && g.collapsed && g.from >= from && g.to <= to) {
        for (let c = g.from; c <= g.to; c++) innerHidden.add(c)
      }
    }
  }
  mutateCols(doc, from, to, (el) => {
    const c = Number(el.getAttribute('min')) - 1
    if (collapsed || innerHidden.has(c)) el.setAttribute('hidden', '1')
    else el.removeAttribute('hidden')
    return COL_KEEP_CHECK.some((a) => el.hasAttribute(a))
  })
  if (summaryAt >= 0 && summaryAt < MAX_COLS) {
    mutateCols(doc, summaryAt, summaryAt, (el) => {
      if (collapsed) el.setAttribute('collapsed', '1')
      else el.removeAttribute('collapsed')
      return COL_KEEP_CHECK.some((a) => el.hasAttribute(a))
    })
  }
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

function collapseRows(
  wb: Workbook,
  sheet: string,
  from: number,
  to: number,
  collapsed: boolean,
): OpResult {
  const info = wb.requireWorksheet(sheet)
  checkSpan('row', from, to)
  const outline = outlineOf(wb, info.name)
  const summaryAt = outline.summaryBelow ? to + 1 : from - 1
  const doc = wb.edit(info.part)
  const innerHidden = new Set<number>()
  if (!collapsed) {
    const targetLevel = Math.min(
      ...outline.rows.filter((g) => g.from <= from && g.to >= to).map((g) => g.level),
      1,
    )
    for (const g of outline.rows) {
      if (g.level > targetLevel && g.collapsed && g.from >= from && g.to <= to) {
        for (let r = g.from; r <= g.to; r++) innerHidden.add(r)
      }
    }
  }
  for (let r = from; r <= to; r++) {
    if (collapsed || innerHidden.has(r)) {
      ensureRow(doc, r).setAttribute('hidden', '1')
    } else {
      const el = findRow(doc, r)
      if (!el) continue
      el.removeAttribute('hidden')
      dropEmptyRow(el)
    }
  }
  if (summaryAt >= 0 && summaryAt < MAX_ROWS) {
    if (collapsed) ensureRow(doc, summaryAt).setAttribute('collapsed', '1')
    else {
      const el = findRow(doc, summaryAt)
      if (el) {
        el.removeAttribute('collapsed')
        dropEmptyRow(el)
      }
    }
  }
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

function setOutlineLevel(
  wb: Workbook,
  sheet: string,
  axis: 'row' | 'col',
  level: number,
): OpResult {
  if (!Number.isInteger(level) || level < 1 || level > MAX_OUTLINE_LEVEL + 1)
    throw new XlsxError(`Outline level must be 1 to ${MAX_OUTLINE_LEVEL + 1}.`)
  const info = wb.requireWorksheet(sheet)
  const outline = outlineOf(wb, info.name)
  const doc = wb.edit(info.part)
  if (axis === 'row') {
    const sheetData = kid(doc.documentElement!, 'sheetData')
    for (const el of sheetData ? kids(sheetData, 'row') : []) {
      const ol = Number(el.getAttribute('outlineLevel') ?? 0)
      if (ol > 0) {
        if (ol >= level) el.setAttribute('hidden', '1')
        else el.removeAttribute('hidden')
      }
      el.removeAttribute('collapsed')
    }
    for (const g of outline.rows) {
      if (g.level >= level && g.summaryAt >= 0 && g.summaryAt < MAX_ROWS) {
        ensureRow(doc, g.summaryAt).setAttribute('collapsed', '1')
      }
    }
    for (const el of sheetData ? kids(sheetData, 'row') : []) dropEmptyRow(el)
  } else {
    for (const g of outline.cols) {
      const hide = g.level >= level
      mutateCols(doc, g.from, g.to, (el) => {
        if (hide) el.setAttribute('hidden', '1')
        else el.removeAttribute('hidden')
        return COL_KEEP_CHECK.some((a) => el.hasAttribute(a))
      })
      if (g.summaryAt >= 0 && g.summaryAt < MAX_COLS) {
        mutateCols(doc, g.summaryAt, g.summaryAt, (el) => {
          if (hide) el.setAttribute('collapsed', '1')
          else el.removeAttribute('collapsed')
          return COL_KEEP_CHECK.some((a) => el.hasAttribute(a))
        })
      }
    }
  }
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

/** Measures the ideal width in Excel characters for column `col`. */
export function autofitColumnWidth(
  wb: Workbook,
  sheet: string,
  col: number,
  locale: SheetLocale = 'en',
): number | null {
  const data = wb.sheet(sheet)
  const styles = wb.styles()
  const calc = createCalc(wb)
  const root = wb.pkg.xml(data.info.part).documentElement!
  const af = kid(root, 'autoFilter')
  let maxChars = 0
  for (const cell of data.cells.values()) {
    if (cell.col !== col) continue
    // Ignore cells inside multi-column merges (Excel does not stretch single columns for horizontal merges)
    const merge = data.merges.find(
      (m) => cell.row >= m.top && cell.row <= m.bottom && cell.col >= m.left && cell.col <= m.right,
    )
    if (merge && merge.right > merge.left) continue
    const out = calc.cell(data.info.name, cell.row, col)
    if (out.value === null) continue
    const st = styles.xf(cell.style)
    const text = displayValue(out.value, formatCode(st.numFmtId, st.numFmt, locale), locale, {
      date1904: wb.date1904,
    }).text
    const lines = text.split(/\r?\n/)
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0)
    const sizeScale = (st.font.sizePt ?? 11) / 11
    const boldScale = st.font.bold ? 1.08 : 1
    const filterPad = af && cell.row === 0 ? 2.5 : 0
    const indentPad = st.indent * 1.5
    const needed = longest * sizeScale * boldScale + 1.5 + filterPad + indentPad
    if (needed > maxChars) maxChars = needed
  }
  if (maxChars <= 0) return null
  return Math.min(255, Math.max(2, Math.round(maxChars * 100) / 100))
}

/** Measures the ideal height in points for row `row`. */
export function autofitRowHeight(
  wb: Workbook,
  sheet: string,
  row: number,
  locale: SheetLocale = 'en',
): number | null {
  const data = wb.sheet(sheet)
  const styles = wb.styles()
  const calc = createCalc(wb)
  let maxPt = 0
  for (const cell of data.cells.values()) {
    if (cell.row !== row) continue
    const merge = data.merges.find(
      (m) => cell.row >= m.top && cell.row <= m.bottom && cell.col >= m.left && cell.col <= m.right,
    )
    if (merge && merge.bottom > merge.top) continue
    const out = calc.cell(data.info.name, row, cell.col)
    if (out.value === null) continue
    const st = styles.xf(cell.style)
    const text = displayValue(out.value, formatCode(st.numFmtId, st.numFmt, locale), locale, {
      date1904: wb.date1904,
    }).text
    if (!text) continue
    const pt = st.font.sizePt ?? 11
    const lineH = Math.ceil(pt * 1.35)
    let lines = text.split(/\r?\n/)
    if (st.wrap) {
      const colInfo = data.cols.find((c) => cell.col >= c.min && cell.col <= c.max)
      const colPx = colInfo?.widthPx ?? data.defaultColPx
      const charsPerLine = Math.max(1, Math.floor((colPx - 8) / (pt * 0.58)))
      lines = lines.flatMap((line) => {
        if (line.length <= charsPerLine) return [line]
        const wrapped: string[] = []
        for (let i = 0; i < line.length; i += charsPerLine)
          wrapped.push(line.slice(i, i + charsPerLine))
        return wrapped
      })
    }
    const h = lines.length * lineH + 4
    if (h > maxPt) maxPt = h
  }
  if (maxPt <= 0) return null
  return Math.min(409, Math.max(15, Math.round(maxPt * 4) / 4))
}

function autofitColumns(
  wb: Workbook,
  sheet: string,
  from: number,
  to: number,
  locale: SheetLocale = 'en',
): OpResult {
  const info = wb.requireWorksheet(sheet)
  checkSpan('col', from, to)
  const widths = new Map<number, number>()
  for (let c = from; c <= to; c++) {
    const w = autofitColumnWidth(wb, info.name, c, locale)
    if (w !== null) widths.set(c, w)
  }
  if (widths.size === 0) return { sheets: [] }
  const doc = wb.edit(info.part)
  for (const [c, w] of widths) {
    mutateCols(doc, c, c, (el) => {
      el.setAttribute('width', String(w))
      el.setAttribute('customWidth', '1')
      el.setAttribute('bestFit', '1')
      el.removeAttribute('hidden')
      return true
    })
  }
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

function autofitRows(
  wb: Workbook,
  sheet: string,
  from: number,
  to: number,
  locale: SheetLocale = 'en',
): OpResult {
  const info = wb.requireWorksheet(sheet)
  checkSpan('row', from, to)
  if (to - from + 1 > 10_000) throw new XlsxError('Autofit at most 10,000 rows at a time.')
  const heights = new Map<number, number>()
  for (let r = from; r <= to; r++) {
    const h = autofitRowHeight(wb, info.name, r, locale)
    if (h !== null) heights.set(r, h)
  }
  if (heights.size === 0) return { sheets: [] }
  const doc = wb.edit(info.part)
  for (const [r, h] of heights) {
    const el = ensureRow(doc, r)
    el.setAttribute('ht', String(h))
    el.setAttribute('customHeight', '1')
    el.removeAttribute('hidden')
  }
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

export function runRowsColsOp(wb: Workbook, op: RowsColsOp): OpResult {
  void setSheetRowColOp
  switch (op.op) {
    case 'hide_columns':
      return hideCols(wb, op.sheet, op.from, op.to, op.hidden)
    case 'hide_rows':
      return hideRows(wb, op.sheet, op.from, op.to, op.hidden)
    case 'group_columns':
      return groupCols(wb, op.sheet, op.from, op.to, 1)
    case 'ungroup_columns':
      return groupCols(wb, op.sheet, op.from, op.to, -1)
    case 'group_rows':
      return groupRows(wb, op.sheet, op.from, op.to, 1)
    case 'ungroup_rows':
      return groupRows(wb, op.sheet, op.from, op.to, -1)
    case 'collapse_columns':
      return collapseCols(wb, op.sheet, op.from, op.to, op.collapsed)
    case 'collapse_rows':
      return collapseRows(wb, op.sheet, op.from, op.to, op.collapsed)
    case 'set_outline_level':
      return setOutlineLevel(wb, op.sheet, op.axis, op.level)
    case 'autofit_columns':
      return autofitColumns(wb, op.sheet, op.from, op.to, op.locale)
    case 'autofit_rows':
      return autofitRows(wb, op.sheet, op.from, op.to, op.locale)
  }
}
