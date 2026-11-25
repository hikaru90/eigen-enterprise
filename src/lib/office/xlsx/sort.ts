import type { SheetEditor } from './editor'
import type { Loss } from './ops'
import { translateFormulaToA1, translateFormulaToR1C1 } from '@borgar/fx'
import { createCalc } from './calc'
import { anchorElements, NS_XDR, oneRowOf } from './drawing'
import { overlaps, tableRanges } from './filter'
import {
  cellKey,
  cellName,
  colName,
  parseCell,
  parseRange,
  rangeName,
  requireCell,
  requireRange,
  type Range,
} from './ref'
import { dropEmptyRow, ensureRow, sheetDataOf, unshareFormulas } from './sheet-xml'
import { isErrorValue, XlsxError, type CellValue, type SheetInfo, type Workbook } from './workbook'
import { all, kid, kids, REL, setText, textOf } from './xml'

/**
 * Sorting a range the way Excel does (Data ▸ Sort): the rows of the range
 * (below its header row, when it has one) are put in order by one or more
 * of its columns; each row's cells move whole — value, format, formula — and
 * a moved formula's relative references move with it, as if the cell had
 * been cut and pasted there (absolute references stay). References from
 * elsewhere into the range are not rewritten, as in Excel. Cells outside the
 * range's columns and hidden rows stay where they are.
 *
 * Excel's order (ascending): numbers, then text (ignoring case), then FALSE
 * and TRUE, then errors (in the order they were); blank cells always come
 * last, also when descending.
 */

export type SortKey = {
  /** The sheet column (from 0), inside the range. */
  col: number
  descending?: boolean
}
export type SortOp = {
  op: 'sort_range'
  sheet: string
  range: string
  keys: SortKey[]
  /** The range's first row is a header and stays where it is. */
  header?: boolean
}

export const MAX_SORT_KEYS = 64


const collator = new Intl.Collator('en', { sensitivity: 'accent' })

const kindRank = (v: CellValue): number =>
  typeof v === 'number'
    ? 0
    : typeof v === 'string'
      ? 1
      : typeof v === 'boolean'
        ? 2
        : isErrorValue(v)
          ? 3
          : 4

/** Excel's sort comparison of two cell values (null: blank, always last). */
export function compareSortValues(a: CellValue, b: CellValue, descending: boolean): number {
  const ra = kindRank(a)
  const rb = kindRank(b)
  if (ra === 4 || rb === 4) return ra === rb ? 0 : ra === 4 ? 1 : -1
  let out: number
  if (ra !== rb) out = ra - rb
  else if (ra === 0) out = (a as number) - (b as number)
  else if (ra === 1) out = collator.compare(a as string, b as string)
  else if (ra === 2) out = Number(a) - Number(b)
  else out = 0
  return descending ? -out : out
}

/** The range's body (rows that move) and checks of the request. */
function plan(wb: Workbook, op: SortOp): { info: SheetInfo; range: Range; body: Range } {
  const info = wb.requireWorksheet(op.sheet)
  const range = requireRange(op.range)
  if (op.keys.length === 0) throw new XlsxError('Name at least one column to sort by.')
  if (op.keys.length > MAX_SORT_KEYS)
    throw new XlsxError(`Sort by at most ${MAX_SORT_KEYS} columns.`)
  for (const k of op.keys)
    if (!Number.isInteger(k.col) || k.col < range.left || k.col > range.right)
      throw new XlsxError(
        `Column ${colName(Math.max(0, k.col))} is outside the range ${rangeName(range)} being sorted.`,
      )
  const body = { ...range, top: op.header ? range.top + 1 : range.top }
  return { info, range, body }
}

/** Comments, pictures and tables in the rows being sorted would stay where they are. */
export function sortLosses(wb: Workbook, op: SortOp): Loss[] {
  const { info, body } = plan(wb, op)
  if (body.top > body.bottom) return []
  const out: Loss[] = []
  const add = (feature: Loss['feature'], count: number) => {
    if (count > 0) out.push({ feature, count })
  }
  const inBody = (row: number, col: number) =>
    row >= body.top && row <= body.bottom && col >= body.left && col <= body.right
  add('tables', tableRanges(wb, info).filter((t) => overlaps(t.range, body)).length)
  let drawings = 0
  for (const r of wb.pkg.relationships(info.part)) {
    if (r.external || !r.part || !wb.pkg.has(r.part)) continue
    // Notes, threads and pictures inside one row move with their rows (ops.ts arrange); larger objects stay.
    if (r.type === `${REL}drawing`) {
      const doc = wb.pkg.xml(r.part)
      for (const el of anchorElements(doc)) {
        const from = el.getElementsByTagNameNS(NS_XDR, 'from')[0]
        if (!from) continue
        const row = Number(textOf(kid(from, 'row', NS_XDR)))
        const col = Number(textOf(kid(from, 'col', NS_XDR)))
        if (inBody(row, col) && (el.namespaceURI !== NS_XDR || oneRowOf(el) === null)) drawings++
      }
    }
  }
  add('drawings', drawings)
  return out
}

/** A moved formula as it reads at its new place; a reference pushed off the sheet becomes #REF! (as in Excel). */
function moveFormula(text: string, from: string, to: string): string {
  return translateFormulaToA1(translateFormulaToR1C1(text, from), to, { wrapEdges: false })
}

/** Sorts the range in the sheet's XML (`doc` from the open transaction). Returns the rows that moved (old -> new) and the sorted cells, or null when nothing moved. */
export function sortRange(
  wb: Workbook,
  doc: XMLDocument,
  op: SortOp,
): { body: Range; dest: Map<number, number> } | null {
  const { info, body } = plan(wb, op)
  if (body.top > body.bottom) return null
  const d = wb.sheet(info.name)
  const where = `${info.name}!${rangeName(body)}`
  const merge = d.merges.find((m) => overlaps(m, body))
  if (merge)
    throw new XlsxError(
      `${where} contains merged cells (${rangeName(merge)}); unmerge them to sort, as in Excel.`,
    )
  for (const c of d.cells.values()) {
    if (c.row < body.top || c.row > body.bottom || c.col < body.left || c.col > body.right) continue
    const arr = c.formulaRef ?? c.inArrayOf
    if (arr)
      throw new XlsxError(
        `${where} contains part of the array formula in ${rangeName(arr)}, which can't be sorted; edit it in Excel.`,
      )
  }
  const calc = createCalc(wb)
  const rows: number[] = []
  for (let r = body.top; r <= body.bottom; r++) if (!d.rows.get(r)?.hidden) rows.push(r)
  const keyed = rows.map((r, i) => ({
    r,
    i,
    keys: op.keys.map((k) => {
      const cell = d.cells.get(cellKey(r, k.col))
      return cell && (cell.value !== null || cell.formula !== null)
        ? calc.cell(info.name, r, k.col).value
        : null
    }),
  }))
  keyed.sort((a, b) => {
    for (let k = 0; k < op.keys.length; k++) {
      const c = compareSortValues(a.keys[k]!, b.keys[k]!, !!op.keys[k]!.descending)
      if (c !== 0) return c
    }
    return a.i - b.i
  })
  /** Old row → new row, for the rows that move. */
  const dest = new Map<number, number>()
  keyed.forEach((k, i) => {
    if (k.r !== rows[i]) dest.set(k.r, rows[i]!)
  })
  if (dest.size === 0) return null

  if (all(doc, 'f').some((f) => f.getAttribute('t') === 'shared'))
    unshareFormulas(doc, (ref) => {
      const a = requireCell(ref)
      return d.cells.get(cellKey(a.row, a.col))?.formula ?? null
    })
  const inCols = (cell: Element) => {
    const col = requireCell(cell.getAttribute('r')!).col
    return col >= body.left && col <= body.right
  }
  // Take the moving cells out of their rows …
  const moving: Array<{ from: number; to: number; cells: Element[] }> = []
  const touched: Element[] = []
  for (const rowEl of kids(sheetDataOf(doc), 'row')) {
    const r = Number(rowEl.getAttribute('r')) - 1
    const to = dest.get(r)
    if (to === undefined) continue
    const cells = kids(rowEl, 'c').filter(inCols)
    for (const c of cells) rowEl.removeChild(c)
    rowEl.removeAttribute('spans')
    moving.push({ from: r, to, cells })
    touched.push(rowEl)
  }
  // … and into their new rows, in column order, formulas moved along.
  for (const m of moving) {
    const rowEl = ensureRow(doc, m.to)
    rowEl.removeAttribute('spans')
    touched.push(rowEl)
    for (const c of m.cells) {
      const col = requireCell(c.getAttribute('r')!).col
      const from = cellName({ row: m.from, col })
      const to = cellName({ row: m.to, col })
      c.setAttribute('r', to)
      const f = kid(c, 'f')
      if (f && textOf(f) !== '') setText(doc, f, moveFormula(textOf(f), from, to))
      const next = kids(rowEl, 'c').find((x) => requireCell(x.getAttribute('r')!).col > col)
      rowEl.insertBefore(c, next ?? null)
    }
  }
  for (const rowEl of touched) if (rowEl.parentNode) dropEmptyRow(rowEl)
  moveHyperlinks(doc, body, dest)
  dropSortStates(doc, body)
  return { body, dest }
}

/** Single-cell hyperlinks move with their cell. */
function moveHyperlinks(doc: XMLDocument, body: Range, dest: Map<number, number>) {
  const links = kid(doc.documentElement!, 'hyperlinks')
  for (const h of links ? kids(links, 'hyperlink') : []) {
    const a = parseCell(h.getAttribute('ref') ?? '')
    if (!a || a.col < body.left || a.col > body.right) continue
    const to = dest.get(a.row)
    if (to !== undefined) h.setAttribute('ref', cellName({ row: to, col: a.col }))
  }
}

/** A saved sort order of these cells (sortState, §18.3.1.92) no longer describes them. */
function dropSortStates(doc: XMLDocument, body: Range) {
  for (const s of all(doc, 'sortState')) {
    const r = parseRange(s.getAttribute('ref') ?? '')
    if (!r || overlaps(r, body)) s.parentNode?.removeChild(s)
  }
}

/**
 * Whether the range's first row looks like a header, as Excel's quick sort
 * decides it from the cells' kinds and formats: every cell of the first row
 * is text, and some column's next row holds another kind or another format.
 */
export function guessHeader(ed: SheetEditor, sheet: string, range: Range): boolean {
  if (range.bottom <= range.top) return false
  const d = ed.wb.sheet(sheet)
  const calc = ed.calc()
  const info = ed.wb.requireWorksheet(sheet)
  let differs = false
  for (let c = range.left; c <= range.right; c++) {
    const head = d.cells.get(cellKey(range.top, c))
    const v = head ? calc.cell(info.name, range.top, c).value : null
    if (typeof v !== 'string' || v === '') return false
    const below = d.cells.get(cellKey(range.top + 1, c))
    const bv = below ? calc.cell(info.name, range.top + 1, c).value : null
    if (typeof bv !== 'string' || (below?.style ?? 0) !== head!.style) differs = true
  }
  return differs
}
