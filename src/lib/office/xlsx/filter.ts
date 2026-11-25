import type { SheetEditor } from './editor'
import { createCalc, type Calc } from './calc'
import { displayValue, formatCode, type SheetLocale } from './format'
import {
  cellKey,
  colName,
  parseRange,
  rangeName,
  requireRange,
  type Range,
} from './ref'
import { WORKSHEET_ORDER } from './sheet-order'
import { currentRegion, setRowHidden } from './sheet-xml'
import { quoteSheet } from './shift'
import {
  readSheetTables,
  setTableAutoFilterEl,
  tableAutoFilterTarget,
  type ExcelTable,
} from './tables'
import { XlsxError, type SheetData, type SheetInfo, type Workbook } from './workbook'
import { insertInOrder, kid, kids, make, REL, setText, WORKBOOK_ORDER } from './xml'

/**
 * AutoFilter (ECMA-376 Part 1 §18.3.1.2): a sheet's filter range with a
 * drop-down per column. Filtering by values writes `filterColumn/filters`
 * (the shown text of each value to keep, `blank="1"` for empty cells) and
 * hides the other rows of the range the way Excel does (`row hidden="1"`).
 * Excel's hidden `_xlnm._FilterDatabase` name for the range is kept with it.
 *
 * Criteria this editor can't evaluate (custom conditions, top 10, dynamic
 * dates, colours, icons, date groups) are kept exactly as written; rows Excel
 * hid for them stay hidden when another column's filter changes.
 */

export type AutoFilterOp = {
  op: 'set_autofilter'
  sheet: string
  range: string | null
  table?: string
}
export type FilterColumnOp = {
  op: 'filter_column'
  sheet: string
  /** The sheet column (from 0), inside the filter range. */
  col: number
  /** The shown texts to keep (matched ignoring case); null clears the column's filter. */
  values: string[] | null
  /** Keep empty cells too. */
  blanks?: boolean
  table?: string
}

export type ColumnFilter =
  | { col: number; kind: 'values'; values: string[]; blanks: boolean }
  /** A criterion kept as Excel wrote it (custom, top 10, dynamic, colour, icon, date groups). */
  | { col: number; kind: 'other' }

export type AutoFilter = { range: Range; columns: ColumnFilter[]; table?: string }

export const AUTO_FILTER_ORDER = ['filterColumn', 'sortState', 'extLst'] as const

export const FILTER_DATABASE = '_xlnm._FilterDatabase'
/** The drop-down lists at most this many values (Excel lists 10 000). */
export const MAX_CHOICES = 10_000

function readColumn(range: Range, el: Element): ColumnFilter | null {
  const id = Number(el.getAttribute('colId'))
  if (!Number.isInteger(id) || id < 0) return null
  const col = range.left + id
  const filters = kid(el, 'filters')
  if (filters && kids(filters, 'dateGroupItem').length === 0) {
    const blank = filters.getAttribute('blank')
    return {
      col,
      kind: 'values',
      values: kids(filters, 'filter').map((f) => f.getAttribute('val') ?? ''),
      blanks: blank === '1' || blank === 'true',
    }
  }
  return kids(el, undefined).length > 0 ? { col, kind: 'other' } : null
}

/** The sheet's autoFilter, or null. */
export function autoFilterOf(wb: Workbook, sheet: string): AutoFilter | null {
  const info = wb.requireWorksheet(sheet)
  const af = kid(wb.pkg.xml(info.part).documentElement!, 'autoFilter')
  const range = af ? parseRange(af.getAttribute('ref') ?? '') : null
  if (!af || !range) return null
  const columns = kids(af, 'filterColumn').flatMap((el) => {
    const c = readColumn(range, el)
    return c ? [c] : []
  })
  return { range, columns }
}

/** All AutoFilters on a sheet: the sheet's own filter (if any) plus every table's AutoFilter. */
export function sheetFilters(wb: Workbook, sheet: string): AutoFilter[] {
  const out: AutoFilter[] = []
  const sheetAf = autoFilterOf(wb, sheet)
  if (sheetAf) out.push(sheetAf)
  for (const t of readSheetTables(wb, sheet)) {
    if (!t.autoFilter || t.headerRowCount === 0) continue
    out.push({
      range: t.autoFilter.range,
      columns: t.autoFilter.columns,
      table: t.displayName,
    })
  }
  return out
}

export { currentRegion }

const filled = (d: SheetData, r: number, c: number) => {
  const cell = d.cells.get(cellKey(r, c))
  return !!cell && (cell.value !== null || cell.formula !== null)
}

/** The ranges of the sheet's tables (they have their own filters). */
export function tableRanges(wb: Workbook, info: SheetInfo): Array<{ name: string; range: Range }> {
  return wb.pkg
    .relationships(info.part)
    .filter((r) => !r.external && r.part && r.type === `${REL}table` && wb.pkg.has(r.part))
    .flatMap((r) => {
      const t = wb.pkg.xml(r.part!).documentElement!
      const range = parseRange(t.getAttribute('ref') ?? '')
      return range
        ? [{ name: t.getAttribute('displayName') ?? t.getAttribute('name') ?? '', range }]
        : []
    })
}

export const overlaps = (a: Range, b: Range) =>
  a.top <= b.bottom && b.top <= a.bottom && a.left <= b.right && b.left <= a.right

/** The text a cell shows, as filter values are written (Excel's English formatting); '' for an empty cell. */
function shownText(
  wb: Workbook,
  calc: Calc,
  d: SheetData,
  r: number,
  c: number,
  locale: SheetLocale,
): string {
  const cell = d.cells.get(cellKey(r, c))
  if (!cell || (cell.value === null && cell.formula === null)) return ''
  const v = calc.cell(d.info.name, r, c).value
  const st = wb.styles().xf(cell.style)
  return displayValue(v, formatCode(st.numFmtId, st.numFmt, locale), locale, {
    date1904: wb.date1904,
  }).text
}

export type FilterChoice = {
  /** What the filter writes and matches (the shown text in Excel's English formatting). */
  value: string
  /** As the person reads it (their locale). */
  label: string
  count: number
}

function resolveFilterTarget(
  wb: Workbook,
  sheet: string,
  col: number,
  tableName?: string,
): { af: AutoFilter; table?: ExcelTable } {
  const tables = readSheetTables(wb, sheet)
  if (tableName !== undefined) {
    const k = tableName.trim().toLowerCase()
    const t = tables.find((x) => x.name.toLowerCase() === k || x.displayName.toLowerCase() === k)
    if (!t) throw new XlsxError(`Sheet “${sheet}” has no table named “${tableName}”.`)
    if (!t.autoFilter || t.headerRowCount === 0)
      throw new XlsxError(`Table “${t.displayName}” has no filter: turn filtering on first.`)
    return { af: { ...t.autoFilter, table: t.displayName }, table: t }
  }
  const sheetAf = autoFilterOf(wb, sheet)
  if (sheetAf && col >= sheetAf.range.left && col <= sheetAf.range.right) return { af: sheetAf }
  const tableMatches = tables.filter(
    (t) =>
      t.headerRowCount > 0 &&
      t.autoFilter &&
      col >= t.autoFilter.range.left &&
      col <= t.autoFilter.range.right,
  )
  if (tableMatches.length === 1) {
    const t = tableMatches[0]!
    return { af: { ...t.autoFilter!, table: t.displayName }, table: t }
  }
  if (tableMatches.length > 1)
    throw new XlsxError(
      `Column ${colName(col)} is in multiple tables on “${sheet}”; specify which table to filter.`,
    )
  if (sheetAf) return { af: sheetAf }
  throw new XlsxError(`“${sheet}” has no filter: turn filtering on for a range first.`)
}

/** The distinct values of a filter column (all its data rows, hidden ones too), sorted as Excel lists them; blanks last as ''. */
export function columnChoices(
  ed: SheetEditor,
  sheet: string,
  col: number,
  locale: SheetLocale = 'en',
  tableName?: string,
): FilterChoice[] {
  const af = tableName
    ? resolveFilterTarget(ed.wb, sheet, col, tableName).af
    : (autoFilterOf(ed.wb, sheet) ??
        sheetFilters(ed.wb, sheet).find((f) => col >= f.range.left && col <= f.range.right) ??
        null)
  if (!af) throw new XlsxError(`“${sheet}” has no filter.`)
  const d = ed.wb.sheet(sheet)
  const calc = ed.calc()
  const seen = new Map<string, FilterChoice & { sort: number }>()
  let blanks = 0
  for (let r = af.range.top + 1; r <= af.range.bottom; r++) {
    const value = shownText(ed.wb, calc, d, r, col, 'en')
    if (value === '') {
      blanks++
      continue
    }
    const key = value.toLowerCase()
    const hit = seen.get(key)
    if (hit) hit.count++
    else {
      const raw = calc.cell(sheet, r, col).value
      seen.set(key, {
        value,
        label: locale === 'en' ? value : shownText(ed.wb, calc, d, r, col, locale),
        count: 1,
        sort: typeof raw === 'number' ? raw : Number.NaN,
      })
    }
    if (seen.size > MAX_CHOICES)
      throw new XlsxError(
        `Column ${colName(col)} has more than ${MAX_CHOICES} different values to list.`,
      )
  }
  const collator = new Intl.Collator('en', { sensitivity: 'accent' })
  const out = [...seen.values()]
    .sort((a, b) => {
      const an = !Number.isNaN(a.sort)
      const bn = !Number.isNaN(b.sort)
      if (an && bn) return a.sort - b.sort
      if (an !== bn) return an ? -1 : 1
      return collator.compare(a.value, b.value)
    })
    .map(({ value, label, count }) => ({ value, label, count }))
  if (blanks) out.push({ value: '', label: '', count: blanks })
  return out
}

// ---------------------------------------------------------------------------
// Writing

function filterNameRef(info: SheetInfo, r: Range): string {
  const abs = (row: number, col: number) => `$${colName(col)}$${row + 1}`
  return `${quoteSheet(info.name)}!${abs(r.top, r.left)}:${abs(r.bottom, r.right)}`
}

/** Excel's hidden name for the filter range: written, moved, or removed (range null). */
function setFilterName(wb: Workbook, info: SheetInfo, range: Range | null) {
  const root = wb.pkg.xml(wb.part).documentElement!
  const namesEl = kid(root, 'definedNames')
  const existing = namesEl
    ? kids(namesEl, 'definedName').find(
        (n) =>
          n.getAttribute('name') === FILTER_DATABASE &&
          n.getAttribute('localSheetId') === String(info.index),
      )
    : undefined
  if (!range && !existing) return
  const doc = wb.edit(wb.part)
  if (!range) {
    namesEl!.removeChild(existing!)
    if (kids(namesEl!, 'definedName').length === 0) doc.documentElement!.removeChild(namesEl!)
    return
  }
  let names = namesEl
  if (!names) {
    names = make(doc, 'definedNames')
    insertInOrder(doc.documentElement!, names, WORKBOOK_ORDER)
  }
  let el = existing
  if (!el) {
    el = make(doc, 'definedName')
    el.setAttribute('name', FILTER_DATABASE)
    el.setAttribute('localSheetId', String(info.index))
    el.setAttribute('hidden', '1')
    names.appendChild(el)
  }
  setText(doc, el, filterNameRef(info, range))
}

function applyFilter(wb: Workbook, info: SheetInfo, doc: XMLDocument, af: AutoFilter) {
  const d = wb.sheet(info.name)
  const calc = createCalc(wb)
  const values = af.columns.flatMap((c) =>
    c.kind === 'values'
      ? [{ col: c.col, keep: new Set(c.values.map((v) => v.toLowerCase())), blanks: c.blanks }]
      : [],
  )
  const others = af.columns.some((c) => c.kind === 'other')
  for (let r = af.range.top + 1; r <= af.range.bottom; r++) {
    let hide = false
    for (const v of values) {
      const t = shownText(wb, calc, d, r, v.col, 'en')
      if (t === '' ? !v.blanks : !v.keep.has(t.toLowerCase())) {
        hide = true
        break
      }
    }
    if (!hide && others) hide = d.rows.get(r)?.hidden ?? false
    setRowHidden(doc, r, hide)
  }
}

function showAll(doc: XMLDocument, range: Range) {
  for (let r = range.top + 1; r <= range.bottom; r++) setRowHidden(doc, r, false)
}

const sameRange = (a: Range, b: Range) =>
  a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right

/** Turns the sheet's or table's filter on for a range (a single cell: its table or current region), or off (null). */
export function setAutoFilter(wb: Workbook, info: SheetInfo, doc: XMLDocument, op: AutoFilterOp) {
  const root = doc.documentElement!
  const tables = readSheetTables(wb, info.name)
  if (op.table !== undefined) {
    const k = op.table.trim().toLowerCase()
    const t = tables.find((x) => x.name.toLowerCase() === k || x.displayName.toLowerCase() === k)
    if (!t) throw new XlsxError(`Sheet “${info.name}” has no table named “${op.table}”.`)
    if (op.range === null) {
      if (t.autoFilter) showAll(doc, t.autoFilter.range)
      setTableAutoFilterEl(wb, t, false)
    } else {
      setTableAutoFilterEl(wb, t, true)
    }
    return
  }

  const old = kid(root, 'autoFilter')
  const oldRange = old ? parseRange(old.getAttribute('ref') ?? '') : null
  if (op.range === null) {
    if (!old) return
    if (oldRange) showAll(doc, oldRange)
    root.removeChild(old)
    setFilterName(wb, info, null)
    return
  }
  let range = requireRange(op.range)
  const d = wb.sheet(info.name)
  if (range.top === range.bottom && range.left === range.right) {
    const hitTable = tables.find(
      (t) =>
        range.top >= t.ref.top &&
        range.top <= t.ref.bottom &&
        range.left >= t.ref.left &&
        range.left <= t.ref.right,
    )
    if (hitTable) {
      setTableAutoFilterEl(wb, hitTable, true)
      return
    }
    range = currentRegion(d, { row: range.top, col: range.left })
    if (
      range.top === range.bottom &&
      range.left === range.right &&
      !filled(d, range.top, range.left)
    )
      throw new XlsxError(
        `${rangeName(range)} is empty: select the cells to filter (the first row is the header).`,
      )
  }
  const exactTable = tables.find((t) => {
    const afTarget = tableAutoFilterTarget(t)
    return sameRange(t.ref, range) || (afTarget ? sameRange(afTarget, range) : false)
  })
  if (exactTable) {
    setTableAutoFilterEl(wb, exactTable, true)
    return
  }
  const table = tableRanges(wb, info).find((t) => overlaps(t.range, range))
  if (table)
    throw new XlsxError(
      `${rangeName(range)} overlaps the table “${table.name}” (${rangeName(table.range)}), which has its own filter.`,
    )
  if (old && oldRange && rangeName(oldRange) === rangeName(range)) return
  if (old) {
    if (oldRange) showAll(doc, oldRange)
    root.removeChild(old)
  }
  const af = make(doc, 'autoFilter')
  af.setAttribute('ref', rangeName(range))
  insertInOrder(root, af, WORKSHEET_ORDER)
  setFilterName(wb, info, range)
}

/** Sets (values) or clears (null) one column's value filter and shows/hides the rows again. */
export function filterColumn(wb: Workbook, info: SheetInfo, doc: XMLDocument, op: FilterColumnOp) {
  const target = resolveFilterTarget(wb, info.name, op.col, op.table)
  const range = target.af.range
  let afDoc: XMLDocument
  let afEl: Element
  if (target.table) {
    afDoc = wb.edit(target.table.part)
    afEl = kid(afDoc.documentElement!, 'autoFilter')!
  } else {
    afDoc = doc
    afEl = kid(doc.documentElement!, 'autoFilter')!
  }
  if (!Number.isInteger(op.col) || op.col < range.left || op.col > range.right)
    throw new XlsxError(
      `Column ${colName(Math.max(0, op.col))} is outside the filter range ${rangeName(range)}.`,
    )
  if (op.values !== null && op.values.length === 0 && !op.blanks)
    throw new XlsxError('Pick at least one value to show (or clear the column’s filter).')
  const id = String(op.col - range.left)
  const existing = kids(afEl, 'filterColumn').find((el) => el.getAttribute('colId') === id)
  if (op.values === null) {
    if (existing) afEl.removeChild(existing)
  } else {
    let el = existing
    if (el) for (const k of kids(el, undefined)) el.removeChild(k)
    else {
      el = make(afDoc, 'filterColumn')
      el.setAttribute('colId', id)
      const next = kids(afEl, undefined).find(
        (k) => k.localName !== 'filterColumn' || Number(k.getAttribute('colId')) > Number(id),
      )
      afEl.insertBefore(el, next ?? null)
    }
    const filters = make(afDoc, 'filters')
    if (op.blanks) filters.setAttribute('blank', '1')
    const unique = new Map<string, string>()
    for (const v of op.values) if (v !== '') unique.set(v.toLowerCase(), v)
    for (const v of unique.values()) {
      const f = make(afDoc, 'filter')
      f.setAttribute('val', v)
      filters.appendChild(f)
    }
    el.appendChild(filters)
  }
  // The model is read from the edited document itself.
  const columns = kids(afEl, 'filterColumn').flatMap((el) => {
    const c = readColumn(range, el)
    return c ? [c] : []
  })
  applyFilter(wb, info, doc, { range, columns })
}

/** The filter as text for the agent's read (drive.sheet_read). */
export function describeAutoFilter(af: AutoFilter) {
  return {
    range: rangeName(af.range),
    columns: af.columns.map((c) =>
      c.kind === 'values'
        ? { column: colName(c.col), values: c.values, blanks: c.blanks }
        : { column: colName(c.col), kept: 'a condition set in Excel (kept as it is)' },
    ),
  }
}
