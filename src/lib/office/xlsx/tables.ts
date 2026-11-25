import type { BorderEdge } from './styles'
import { parseStructRef, tokenize } from '@borgar/fx/xlsx'
import { strToU8 } from 'fflate'
import { relsPartOf } from '../ooxml/package'
import { resolveStructured, type Table } from './calc-refs'
import { AUTO_FILTER_ORDER, type AutoFilter, type ColumnFilter } from './filter'
import {
  cellKey,
  cellName,
  MAX_ROWS,
  parseCell,
  parseRange,
  rangeName,
  requireRange,
  type Range,
} from './ref'
import { WORKSHEET_ORDER } from './sheet-order'
import {
  currentRegion,
  normalizeRefs,
  setRowHidden,
  sheetDataOf,
  writeCell,
} from './sheet-xml'
import { quoteSheet, translateFormula } from './shift'
import { XlsxError, type SheetInfo, type Workbook } from './workbook'
import {
  all,
  insertInOrder,
  kid,
  kids,
  make,
  NS_MAIN,
  NS_R,
  REL,
  setText,
  textOf,
} from './xml'

/**
 * Excel Tables (ECMA-376 Part 1 §18.5.1, `xl/tables/tableN.xml`):
 * creation (Ctrl+T), built-in styles, header row, totals row with SUBTOTAL,
 * banded rows/columns, auto-expand on adjacent writes, resizing/renaming,
 * converting to a plain range (rewriting structured refs to A1), and cell looks
 * for grid rendering.
 */

export const CT_TABLE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml'
export const REL_TABLE = `${REL}table`

export type TotalsFunction =
  | 'none'
  | 'sum'
  | 'count'
  | 'average'
  | 'min'
  | 'max'
  | 'countNums'
  | 'stdDev'
  | 'var'
  | 'custom'

export type TableColumnSpec = {
  id: number
  name: string
  totalsRowLabel?: string
  totalsRowFunction?: TotalsFunction
  totalsRowFormula?: string
}

export type TableStyleOptions = {
  name: string
  showFirstColumn: boolean
  showLastColumn: boolean
  showRowStripes: boolean
  showColumnStripes: boolean
}

export type ExcelTable = {
  id: number
  name: string
  displayName: string
  sheet: string
  part: string
  relId: string
  ref: Range
  headerRowCount: number
  totalsRowCount: number
  autoFilter: AutoFilter | null
  columns: TableColumnSpec[]
  style: TableStyleOptions
}

export type TotalsColumnUpdate = {
  column: string | number
  function: TotalsFunction
  label?: string
  formula?: string
}

export type CreateTableOp = {
  op: 'create_table'
  sheet: string
  range: string
  name?: string
  hasHeaders?: boolean
  style?: string
  autoFilter?: boolean
}

export type UpdateTableOp = {
  op: 'update_table'
  sheet: string
  table: string
  name?: string
  ref?: string
  headerRow?: boolean
  totalsRow?: boolean
  totalsColumns?: TotalsColumnUpdate[]
  style?: string
  showFirstColumn?: boolean
  showLastColumn?: boolean
  showRowStripes?: boolean
  showColumnStripes?: boolean
  autoFilter?: boolean
}

export type DeleteTableOp = {
  op: 'delete_table'
  sheet: string
  table: string
  mode?: 'convert_to_range' | 'delete_cells'
}

export type TableOp = CreateTableOp | UpdateTableOp | DeleteTableOp

export type TableCellLook = {
  fill?: string
  color?: string
  bold?: boolean
  borderTop?: BorderEdge
  borderBottom?: BorderEdge
}

export type TableStylePalette = {
  id: string
  label: string
  headerFill: string
  headerColor: string
  stripeFill: string
  totalFill?: string
  accent: string
}

/** Excel built-in table style palettes for grid rendering and style picker UI. */
export const TABLE_STYLE_PRESETS: readonly TableStylePalette[] = [
  {
    id: 'TableStyleMedium2',
    label: 'Blue Medium 2',
    headerFill: '#4472C4',
    headerColor: '#FFFFFF',
    stripeFill: '#D9E1F2',
    totalFill: '#D9E1F2',
    accent: '#4472C4',
  },
  {
    id: 'TableStyleMedium9',
    label: 'Blue Medium 9',
    headerFill: '#2F5597',
    headerColor: '#FFFFFF',
    stripeFill: '#D9E1F2',
    totalFill: '#D9E1F2',
    accent: '#2F5597',
  },
  {
    id: 'TableStyleMedium4',
    label: 'Gray Medium 4',
    headerFill: '#A5A5A5',
    headerColor: '#FFFFFF',
    stripeFill: '#EDEDED',
    totalFill: '#EDEDED',
    accent: '#A5A5A5',
  },
  {
    id: 'TableStyleMedium6',
    label: 'Green Medium 6',
    headerFill: '#70AD47',
    headerColor: '#FFFFFF',
    stripeFill: '#E2EFDA',
    totalFill: '#E2EFDA',
    accent: '#70AD47',
  },
  {
    id: 'TableStyleMedium3',
    label: 'Orange Medium 3',
    headerFill: '#ED7D31',
    headerColor: '#FFFFFF',
    stripeFill: '#FCE4D6',
    totalFill: '#FCE4D6',
    accent: '#ED7D31',
  },
  {
    id: 'TableStyleMedium1',
    label: 'Black Medium 1',
    headerFill: '#000000',
    headerColor: '#FFFFFF',
    stripeFill: '#D9D9D9',
    totalFill: '#D9D9D9',
    accent: '#595959',
  },
  {
    id: 'TableStyleLight9',
    label: 'Blue Light 9',
    headerFill: '#D9E1F2',
    headerColor: '#000000',
    stripeFill: '#EDF2F8',
    accent: '#4472C4',
  },
  {
    id: 'TableStyleLight11',
    label: 'Green Light 11',
    headerFill: '#E2EFDA',
    headerColor: '#000000',
    stripeFill: '#F2F8EE',
    accent: '#70AD47',
  },
  {
    id: 'TableStyleLight1',
    label: 'Light 1',
    headerFill: '#FFFFFF',
    headerColor: '#000000',
    stripeFill: '#F2F2F2',
    accent: '#000000',
  },
  {
    id: 'TableStyleDark1',
    label: 'Dark 1',
    headerFill: '#000000',
    headerColor: '#FFFFFF',
    stripeFill: '#D9D9D9',
    totalFill: '#BFBFBF',
    accent: '#000000',
  },
  {
    id: 'TableStyleDark2',
    label: 'Blue Dark 2',
    headerFill: '#1F4E78',
    headerColor: '#FFFFFF',
    stripeFill: '#B4C6E7',
    totalFill: '#8EA9DB',
    accent: '#1F4E78',
  },
  {
    id: 'TableStyleDark7',
    label: 'Green Dark 7',
    headerFill: '#375623',
    headerColor: '#FFFFFF',
    stripeFill: '#C6E0B4',
    totalFill: '#A9D08E',
    accent: '#375623',
  },
] as const

const OFFICE_ACCENTS = [
  { header: '#4472C4', stripe: '#D9E1F2', total: '#D9E1F2' }, // Accent 1 (blue)
  { header: '#ED7D31', stripe: '#FCE4D6', total: '#FCE4D6' }, // Accent 2 (orange)
  { header: '#A5A5A5', stripe: '#EDEDED', total: '#EDEDED' }, // Accent 3 (gray)
  { header: '#FFC000', stripe: '#FFF2CC', total: '#FFF2CC' }, // Accent 4 (gold)
  { header: '#5B9BD5', stripe: '#DDEBF7', total: '#DDEBF7' }, // Accent 5 (sky)
  { header: '#70AD47', stripe: '#E2EFDA', total: '#E2EFDA' }, // Accent 6 (green)
] as const

const PRESET_MAP = new Map(TABLE_STYLE_PRESETS.map((p) => [p.id.toLowerCase(), p]))

export function isBuiltinTableStyle(name: string): boolean {
  const m = /^TableStyle(Light|Medium|Dark)(\d+)$/i.exec(name.trim())
  if (!m) return false
  const kind = m[1]!.toLowerCase()
  const idx = Number(m[2])
  if (kind === 'light') return idx >= 1 && idx <= 21
  if (kind === 'medium') return idx >= 1 && idx <= 28
  return idx >= 1 && idx <= 11
}

export function resolveTablePalette(name: string): TableStylePalette {
  const key = name.trim().toLowerCase()
  const preset = PRESET_MAP.get(key)
  if (preset) return preset
  const m = /^TableStyle(Light|Medium|Dark)(\d+)$/i.exec(name.trim())
  if (m) {
    const kind = m[1]!.toLowerCase()
    const num = Number(m[2])
    const accent = OFFICE_ACCENTS[(num - 2 + OFFICE_ACCENTS.length) % OFFICE_ACCENTS.length]!
    if (kind === 'light') {
      return {
        id: name,
        label: name,
        headerFill: num === 1 || num === 8 || num === 15 ? '#FFFFFF' : accent.stripe,
        headerColor: '#000000',
        stripeFill: '#F2F4F8',
        accent: accent.header,
      }
    }
    if (kind === 'dark') {
      return {
        id: name,
        label: name,
        headerFill: num === 1 || num === 8 ? '#000000' : accent.header,
        headerColor: '#FFFFFF',
        stripeFill: accent.stripe,
        totalFill: accent.total,
        accent: accent.header,
      }
    }
    return {
      id: name,
      label: name,
      headerFill: accent.header,
      headerColor: '#FFFFFF',
      stripeFill: accent.stripe,
      totalFill: accent.total,
      accent: accent.header,
    }
  }
  return PRESET_MAP.get('tablestylemedium2')!
}

/** Visual overrides for a cell inside any Excel table on a sheet (cell styles still take precedence in the grid). */
export function tableCellLook(tables: readonly ExcelTable[], row: number, col: number): TableCellLook | null {
  for (const t of tables) {
    const r = t.ref
    if (row < r.top || row > r.bottom || col < r.left || col > r.right) continue
    const pal = resolveTablePalette(t.style.name)
    if (t.headerRowCount > 0 && row === r.top) {
      return {
        fill: pal.headerFill,
        color: pal.headerColor,
        bold: true,
        borderBottom: { style: 'thin', color: pal.accent },
      }
    }
    if (t.totalsRowCount > 0 && row === r.bottom) {
      return {
        fill: pal.totalFill,
        bold: true,
        borderTop: { style: 'thin', color: pal.accent },
        borderBottom: { style: 'double', color: pal.accent },
      }
    }
    const dataTop = r.top + t.headerRowCount
    const dataBottom = r.bottom - t.totalsRowCount
    if (row < dataTop || row > dataBottom) continue
    const rowStripe = t.style.showRowStripes && (row - dataTop) % 2 === 0
    const colStripe = t.style.showColumnStripes && (col - r.left) % 2 === 1
    const firstCol = t.style.showFirstColumn && col === r.left
    const lastCol = t.style.showLastColumn && col === r.right
    const look: TableCellLook = {}
    if (rowStripe || colStripe) look.fill = pal.stripeFill
    if (firstCol || lastCol) look.bold = true
    if (row === dataBottom) look.borderBottom = { style: 'thin', color: pal.accent }
    return Object.keys(look).length > 0 ? look : null
  }
  return null
}

// ---------------------------------------------------------------------------
// Reading & querying tables

const TABLE_CHILD_ORDER = [
  'autoFilter',
  'sortState',
  'tableColumns',
  'tableStyleInfo',
  'extLst',
] as const

const TOTALS_SUBTOTAL: Record<string, number> = {
  average: 101,
  countNums: 102,
  count: 103,
  max: 104,
  min: 105,
  stdDev: 107,
  sum: 109,
  var: 110,
}

const VALID_TOTALS_FNS = new Set<TotalsFunction>([
  'none',
  'sum',
  'count',
  'average',
  'min',
  'max',
  'countNums',
  'stdDev',
  'var',
  'custom',
])

const boolAttr = (el: Element | null, name: string, fallback: boolean): boolean => {
  const v = el?.getAttribute(name)
  if (v === null || v === undefined) return fallback
  return v === '1' || v === 'true'
}

function readAutoFilterEl(af: Element | null): AutoFilter | null {
  if (!af) return null
  const range = parseRange(af.getAttribute('ref') ?? '')
  if (!range) return null
  const columns: ColumnFilter[] = []
  for (const el of kids(af, 'filterColumn')) {
    const id = Number(el.getAttribute('colId'))
    if (!Number.isInteger(id) || id < 0) continue
    const col = range.left + id
    const filters = kid(el, 'filters')
    if (filters && kids(filters, 'dateGroupItem').length === 0) {
      const blank = filters.getAttribute('blank')
      columns.push({
        col,
        kind: 'values',
        values: kids(filters, 'filter').map((f) => f.getAttribute('val') ?? ''),
        blanks: blank === '1' || blank === 'true',
      })
    } else if (kids(el, undefined).length > 0) {
      columns.push({ col, kind: 'other' })
    }
  }
  return { range, columns }
}

function parseTableDoc(sheet: string, part: string, relId: string, doc: XMLDocument): ExcelTable | null {
  const root = doc.documentElement
  if (!root || root.localName !== 'table') return null
  const ref = parseRange(root.getAttribute('ref') ?? '')
  if (!ref) return null
  const name = root.getAttribute('name') ?? root.getAttribute('displayName') ?? ''
  const displayName = root.getAttribute('displayName') ?? name
  const colsEl = kid(root, 'tableColumns')
  const columns: TableColumnSpec[] = (colsEl ? kids(colsEl, 'tableColumn') : []).map((c, idx) => {
    const fn = c.getAttribute('totalsRowFunction') as TotalsFunction | null
    const lbl = c.getAttribute('totalsRowLabel')
    const fEl = kid(c, 'totalsRowFormula')
    return {
      id: Number(c.getAttribute('id') ?? idx + 1),
      name: c.getAttribute('name') ?? `Column${idx + 1}`,
      ...(lbl !== null ? { totalsRowLabel: lbl } : {}),
      ...(fn && VALID_TOTALS_FNS.has(fn) ? { totalsRowFunction: fn } : {}),
      ...(fEl && textOf(fEl) !== '' ? { totalsRowFormula: textOf(fEl) } : {}),
    }
  })
  const styleEl = kid(root, 'tableStyleInfo')
  return {
    id: Number(root.getAttribute('id') ?? 0),
    name,
    displayName,
    sheet,
    part,
    relId,
    ref,
    headerRowCount: Number(root.getAttribute('headerRowCount') ?? 1),
    totalsRowCount: Number(root.getAttribute('totalsRowCount') ?? 0),
    autoFilter: readAutoFilterEl(kid(root, 'autoFilter')),
    columns,
    style: {
      name: styleEl?.getAttribute('name') ?? 'TableStyleMedium2',
      showFirstColumn: boolAttr(styleEl, 'showFirstColumn', false),
      showLastColumn: boolAttr(styleEl, 'showLastColumn', false),
      showRowStripes: boolAttr(styleEl, 'showRowStripes', true),
      showColumnStripes: boolAttr(styleEl, 'showColumnStripes', false),
    },
  }
}

export function readSheetTables(wb: Workbook, sheet: string): ExcelTable[] {
  const info = wb.requireWorksheet(sheet)
  const out: ExcelTable[] = []
  for (const rel of wb.pkg.relationships(info.part)) {
    if (rel.external || rel.type !== REL_TABLE || !rel.part || !wb.pkg.has(rel.part)) continue
    const t = parseTableDoc(info.name, rel.part, rel.id, wb.pkg.xml(rel.part))
    if (t) out.push(t)
  }
  return out
}

export function readWorkbookTables(wb: Workbook): ExcelTable[] {
  const out: ExcelTable[] = []
  for (const s of wb.sheets()) {
    if (s.kind !== 'worksheet') continue
    out.push(...readSheetTables(wb, s.name))
  }
  return out
}

export function findTable(wb: Workbook, sheet: string, name: string): ExcelTable {
  const key = name.trim().toLowerCase()
  const hit = readSheetTables(wb, sheet).find(
    (t) => t.name.toLowerCase() === key || t.displayName.toLowerCase() === key,
  )
  if (!hit) throw new XlsxError(`Sheet “${sheet}” has no table named “${name}”.`)
  return hit
}

export function tableAtCell(wb: Workbook, sheet: string, row: number, col: number): ExcelTable | null {
  return (
    readSheetTables(wb, sheet).find(
      (t) => row >= t.ref.top && row <= t.ref.bottom && col >= t.ref.left && col <= t.ref.right,
    ) ?? null
  )
}

export function tableAutoFilterTarget(t: ExcelTable): Range | null {
  if (t.headerRowCount === 0) return null
  return { ...t.ref, bottom: Math.max(t.ref.top, t.ref.bottom - t.totalsRowCount) }
}

export function tableSummary(t: ExcelTable) {
  return {
    name: t.displayName,
    ref: rangeName(t.ref),
    headerRow: t.headerRowCount > 0,
    totalsRow: t.totalsRowCount > 0,
    autoFilter: t.autoFilter !== null,
    style: t.style.name,
    columns: t.columns.map((c) => c.name),
  }
}

export function setTableAutoFilterEl(wb: Workbook, t: ExcelTable, enable: boolean): XMLDocument {
  const doc = wb.edit(t.part)
  const root = doc.documentElement!
  const old = kid(root, 'autoFilter')
  if (!enable) {
    if (old) root.removeChild(old)
    return doc
  }
  const target = tableAutoFilterTarget(t)
  if (!target) throw new XlsxError(`Table “${t.displayName}” has no header row to filter.`)
  const af = old ?? make(doc, 'autoFilter')
  af.setAttribute('ref', rangeName(target))
  if (!old) insertInOrder(root, af, TABLE_CHILD_ORDER)
  return doc
}

export function setTableSortState(
  wb: Workbook,
  t: ExcelTable,
  sortBody: Range,
  keys: Array<{ col: number; descending?: boolean }>,
) {
  const doc = wb.edit(t.part)
  const root = doc.documentElement!
  const parent = kid(root, 'autoFilter') ?? root
  const old = kid(parent, 'sortState')
  if (old) parent.removeChild(old)
  const ss = make(doc, 'sortState')
  ss.setAttribute('ref', rangeName(sortBody))
  for (const k of keys) {
    const cond = make(doc, 'sortCondition')
    if (k.descending) cond.setAttribute('descending', '1')
    cond.setAttribute(
      'ref',
      rangeName({ top: sortBody.top, bottom: sortBody.bottom, left: k.col, right: k.col }),
    )
    ss.appendChild(cond)
  }
  if (parent === root) insertInOrder(root, ss, TABLE_CHILD_ORDER)
  else insertInOrder(parent, ss, AUTO_FILTER_ORDER)
}

export function clearTableSortStates(wb: Workbook, info: SheetInfo, body: Range) {
  for (const t of readSheetTables(wb, info.name)) {
    if (!rangesOverlap(t.ref, body)) continue
    const doc = wb.pkg.xml(t.part)
    if (all(doc, 'sortState').length === 0) continue
    const edit = wb.edit(t.part)
    for (const s of all(edit, 'sortState')) s.parentNode?.removeChild(s)
  }
}

// ---------------------------------------------------------------------------
// Helpers

const rangesOverlap = (a: Range, b: Range) =>
  a.top <= b.bottom && b.top <= a.bottom && a.left <= b.right && b.left <= a.right

const sameRange = (a: Range, b: Range) =>
  a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right

function pivotRangesOnSheet(wb: Workbook, info: SheetInfo): Array<{ name: string; range: Range }> {
  const out: Array<{ name: string; range: Range }> = []
  for (const rel of wb.pkg.relationships(info.part)) {
    if (rel.external || rel.type !== `${REL}pivotTable` || !rel.part || !wb.pkg.has(rel.part)) continue
    const root = wb.pkg.xml(rel.part).documentElement
    if (!root) continue
    const loc = kid(root, 'location')
    const r = loc ? parseRange(loc.getAttribute('ref') ?? '') : null
    if (r) out.push({ name: root.getAttribute('name') ?? 'PivotTable', range: r })
  }
  return out
}

function checkNoOverlap(
  wb: Workbook,
  info: SheetInfo,
  range: Range,
  opts: { ignoreTablePart?: string; ignoreAutoFilter?: boolean } = {},
) {
  const data = wb.sheet(info.name)
  const merge = data.merges.find((m) => rangesOverlap(m, range))
  if (merge)
    throw new XlsxError(
      `${rangeName(range)} overlaps merged cells ${rangeName(merge)}; unmerge them first.`,
    )
  for (const t of readSheetTables(wb, info.name)) {
    if (opts.ignoreTablePart && t.part === opts.ignoreTablePart) continue
    if (rangesOverlap(t.ref, range))
      throw new XlsxError(
        `${rangeName(range)} overlaps table “${t.displayName}” (${rangeName(t.ref)}).`,
      )
  }
  const pivot = pivotRangesOnSheet(wb, info).find((p) => rangesOverlap(p.range, range))
  if (pivot)
    throw new XlsxError(
      `${rangeName(range)} overlaps pivot table “${pivot.name}” (${rangeName(pivot.range)}).`,
    )
  if (!opts.ignoreAutoFilter) {
    const afEl = kid(wb.pkg.xml(info.part).documentElement!, 'autoFilter')
    const af = afEl ? parseRange(afEl.getAttribute('ref') ?? '') : null
    if (af && rangesOverlap(af, range) && !sameRange(af, range))
      throw new XlsxError(
        `${rangeName(range)} overlaps sheet AutoFilter (${rangeName(af)}); remove the sheet filter first.`,
      )
  }
}

function checkTableName(wb: Workbook, raw: string, ignoreTablePart?: string): string {
  const n = raw.trim()
  if (!n) throw new XlsxError('Table name cannot be empty.')
  if (n.length > 255) throw new XlsxError(`“${n}” exceeds the 255-character table name limit.`)
  if (/^\s|\s$/.test(raw) || /[\s'"/\\?*[\]:]/.test(n))
    throw new XlsxError(`Table name “${n}” cannot contain spaces or punctuation.`)
  if (!/^[A-Za-z_\\\p{L}]/u.test(n))
    throw new XlsxError(`Table name “${n}” must start with a letter or underscore.`)
  if (parseCell(n) !== null || /^[RC]\d+$/i.test(n))
    throw new XlsxError(`Table name “${n}” looks like a cell reference.`)
  const key = n.toLowerCase()
  for (const t of readWorkbookTables(wb)) {
    if (ignoreTablePart && t.part === ignoreTablePart) continue
    if (t.name.toLowerCase() === key || t.displayName.toLowerCase() === key)
      throw new XlsxError(`There is already a table named “${t.displayName}”.`)
  }
  if (wb.definedNames().some((d) => d.name.toLowerCase() === key))
    throw new XlsxError(`There is already a defined name “${n}”.`)
  return n
}

function nextDefaultTableName(wb: Workbook): string {
  const used = new Set<string>([
    ...readWorkbookTables(wb).map((t) => t.displayName.toLowerCase()),
    ...wb.definedNames().map((d) => d.name.toLowerCase()),
  ])
  for (let i = 1; ; i++) {
    const candidate = `Table${i}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

function cellHeaderText(wb: Workbook, sheet: string, row: number, col: number): string {
  const c = wb.sheet(sheet).cells.get(cellKey(row, col))
  if (!c || c.value === null) return ''
  return String(c.value).trim()
}

function uniqueColumnNames(raw: string[]): string[] {
  const used = new Set<string>()
  const out: string[] = []
  let autoIdx = 1
  for (const r of raw) {
    let base = r.trim()
    if (!base) {
      while (used.has(`column${autoIdx}`)) autoIdx++
      base = `Column${autoIdx++}`
    }
    let name = base
    let suffix = 2
    while (used.has(name.toLowerCase())) name = `${base}${suffix++}`
    used.add(name.toLowerCase())
    out.push(name)
  }
  return out
}

function escapeStructCol(colNameStr: string): string {
  return colNameStr.replace(/['[\]#@]/g, (ch) => `'${ch}`)
}

function buildTableXml(t: {
  id: number
  name: string
  ref: Range
  headerRowCount: number
  totalsRowCount: number
  autoFilter: AutoFilter | null
  columns: TableColumnSpec[]
  style: TableStyleOptions
}): string {
  const attrs = [
    `xmlns="${NS_MAIN}"`,
    `id="${t.id}"`,
    `name="${escXml(t.name)}"`,
    `displayName="${escXml(t.name)}"`,
    `ref="${rangeName(t.ref)}"`,
    `headerRowCount="${t.headerRowCount}"`,
    ...(t.totalsRowCount > 0 ? [`totalsRowCount="${t.totalsRowCount}"`] : []),
  ]
  const afXml = t.autoFilter
    ? `<autoFilter ref="${rangeName(t.autoFilter.range)}"/>`
    : ''
  const colsXml = t.columns
    .map((c) => {
      const ca = [`id="${c.id}"`, `name="${escXml(c.name)}"`]
      if (c.totalsRowLabel !== undefined) ca.push(`totalsRowLabel="${escXml(c.totalsRowLabel)}"`)
      if (c.totalsRowFunction) ca.push(`totalsRowFunction="${c.totalsRowFunction}"`)
      if (c.totalsRowFormula !== undefined)
        return `<tableColumn ${ca.join(' ')}><totalsRowFormula>${escXml(c.totalsRowFormula)}</totalsRowFormula></tableColumn>`
      return `<tableColumn ${ca.join(' ')}/>`
    })
    .join('')
  const styleXml = `<tableStyleInfo name="${escXml(t.style.name)}" showFirstColumn="${t.style.showFirstColumn ? 1 : 0}" showLastColumn="${t.style.showLastColumn ? 1 : 0}" showRowStripes="${t.style.showRowStripes ? 1 : 0}" showColumnStripes="${t.style.showColumnStripes ? 1 : 0}"/>`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table ${attrs.join(' ')}>${afXml}<tableColumns count="${t.columns.length}">${colsXml}</tableColumns>${styleXml}</table>`
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function writeTableColumnsEl(doc: XMLDocument, root: Element, columns: TableColumnSpec[]) {
  const old = kid(root, 'tableColumns')
  const el = make(doc, 'tableColumns')
  el.setAttribute('count', String(columns.length))
  for (const c of columns) {
    const col = make(doc, 'tableColumn')
    col.setAttribute('id', String(c.id))
    col.setAttribute('name', c.name)
    if (c.totalsRowLabel !== undefined) col.setAttribute('totalsRowLabel', c.totalsRowLabel)
    if (c.totalsRowFunction) col.setAttribute('totalsRowFunction', c.totalsRowFunction)
    if (c.totalsRowFormula !== undefined) {
      const f = make(doc, 'totalsRowFormula')
      setText(doc, f, c.totalsRowFormula)
      col.appendChild(f)
    }
    el.appendChild(col)
  }
  if (old) root.replaceChild(el, old)
  else insertInOrder(root, el, TABLE_CHILD_ORDER)
}

function writeTableStyleEl(doc: XMLDocument, root: Element, style: TableStyleOptions) {
  const old = kid(root, 'tableStyleInfo')
  const el = old ?? make(doc, 'tableStyleInfo')
  el.setAttribute('name', style.name)
  el.setAttribute('showFirstColumn', style.showFirstColumn ? '1' : '0')
  el.setAttribute('showLastColumn', style.showLastColumn ? '1' : '0')
  el.setAttribute('showRowStripes', style.showRowStripes ? '1' : '0')
  el.setAttribute('showColumnStripes', style.showColumnStripes ? '1' : '0')
  if (!old) insertInOrder(root, el, TABLE_CHILD_ORDER)
}

function clearTableFilterRows(doc: XMLDocument, t: ExcelTable) {
  const af = t.autoFilter
  if (!af) return
  for (let r = af.range.top + 1; r <= af.range.bottom; r++) setRowHidden(doc, r, false)
}

function rewriteWorkbookFormulas(
  wb: Workbook,
  rewrite: (formula: string, home: string, addr: { row: number; col: number } | null) => string,
) {
  for (const s of wb.sheets()) {
    if (s.kind !== 'worksheet') continue
    const doc = wb.pkg.xml(s.part)
    const changes: Array<{ el: Element; next: string }> = []
    for (const rowEl of kids(sheetDataOf(doc), 'row')) {
      const r = Number(rowEl.getAttribute('r') ?? 0) - 1
      for (const cEl of kids(rowEl, 'c')) {
        const ref = cEl.getAttribute('r')
        const cellRange = ref ? parseRange(ref) : null
        const addr = cellRange ? { row: cellRange.top, col: cellRange.left } : { row: Math.max(0, r), col: 0 }
        const f = kid(cEl, 'f')
        if (!f) continue
        const t = textOf(f)
        if (!t) continue
        const next = rewrite(t, s.name, addr)
        if (next !== t) changes.push({ el: f, next })
      }
    }
    for (const tag of ['formula', 'formula1', 'formula2'] as const) {
      for (const el of all(doc, tag)) {
        const t = textOf(el)
        if (!t) continue
        const next = rewrite(t, s.name, null)
        if (next !== t) changes.push({ el, next })
      }
    }
    if (changes.length === 0) continue
    const edit = wb.edit(s.part)
    for (const c of changes) setText(edit, c.el, c.next)
  }
  const namesEl = kid(wb.pkg.xml(wb.part).documentElement!, 'definedNames')
  if (namesEl) {
    const sheets = wb.sheets()
    const changes = kids(namesEl, 'definedName').flatMap((el) => {
      const local = el.getAttribute('localSheetId')
      const home = local !== null ? (sheets[Number(local)]?.name ?? '\u0000') : '\u0000'
      const next = rewrite(textOf(el), home, null)
      return next === textOf(el) ? [] : [{ el, next }]
    })
    if (changes.length > 0) {
      const edit = wb.edit(wb.part)
      for (const c of changes) setText(edit, c.el, c.next)
    }
  }
}

function renameTableRefsInFormula(formula: string, oldName: string, newName: string): string {
  const key = oldName.toLowerCase()
  let changed = false
  const toks = tokenize(formula, { mergeRefs: true }) as Array<{ type: string; value: string }>
  const out = toks.map((t) => {
    if (t.type === 'structured') {
      const parsed = parseStructRef(t.value) as { workbookName?: string; table?: string } | undefined
      if (parsed && !parsed.workbookName && parsed.table?.toLowerCase() === key) {
        changed = true
        return newName + t.value.slice(parsed.table.length)
      }
      return t.value
    }
    if (t.type !== 'string' && t.type !== 'func' && t.type !== 'error' && t.type !== 'context') {
      if (t.value.toLowerCase() === key) {
        changed = true
        return newName
      }
    }
    return t.value
  })
  return changed ? out.join('') : formula
}

function convertTableRefsInFormula(
  formula: string,
  home: string,
  addr: { row: number; col: number } | null,
  table: ExcelTable,
  mode: 'convert_to_range' | 'delete_cells',
): string {
  const calcTable: Table = {
    name: table.displayName,
    sheet: table.sheet,
    ref: table.ref,
    headerRows: table.headerRowCount,
    totalsRows: table.totalsRowCount,
    columns: table.columns.map((c) => c.name),
  }
  const key = table.displayName.toLowerCase()
  let changed = false
  const toks = tokenize(formula, { mergeRefs: true }) as Array<{ type: string; value: string }>
  const out = toks.map((t) => {
    if (t.type === 'structured') {
      const parsed = parseStructRef(t.value) as { workbookName?: string; table?: string } | undefined
      if (!parsed || parsed.workbookName) return t.value
      const targetsTable = parsed.table
        ? parsed.table.toLowerCase() === key || parsed.table.toLowerCase() === table.name.toLowerCase()
        : addr !== null &&
          home.toLowerCase() === table.sheet.toLowerCase() &&
          addr.row >= table.ref.top &&
          addr.row <= table.ref.bottom &&
          addr.col >= table.ref.left &&
          addr.col <= table.ref.right
      if (!targetsTable) return t.value
      changed = true
      if (mode === 'delete_cells') return '#REF!'
      try {
        const res = resolveStructured(t.value, [calcTable], addr ? { sheet: home, ...addr } : null)
        if ('error' in res) return res.error
        const r = res.ref
        const rn = rangeName(r)
        return r.sheet.toLowerCase() === home.toLowerCase() ? rn : `${quoteSheet(r.sheet)}!${rn}`
      } catch {
        return '#REF!'
      }
    }
    if (
      t.type !== 'string' &&
      t.type !== 'func' &&
      t.type !== 'error' &&
      t.type !== 'context' &&
      (t.value.toLowerCase() === key || t.value.toLowerCase() === table.name.toLowerCase())
    ) {
      changed = true
      if (mode === 'delete_cells') return '#REF!'
      const dataTop = table.ref.top + table.headerRowCount
      const dataBottom = table.ref.bottom - table.totalsRowCount
      if (dataBottom < dataTop) return '#REF!'
      const r: Range = { ...table.ref, top: dataTop, bottom: dataBottom }
      const rn = rangeName(r)
      return table.sheet.toLowerCase() === home.toLowerCase() ? rn : `${quoteSheet(table.sheet)}!${rn}`
    }
    return t.value
  })
  return changed ? out.join('') : formula
}

// ---------------------------------------------------------------------------
// Create, Update, Delete, Auto-expand

export function createTable(wb: Workbook, op: CreateTableOp): { sheets: string[]; table: string } {
  const info = wb.requireWorksheet(op.sheet)
  const doc = wb.edit(info.part)
  normalizeRefs(doc)
  const data = wb.sheet(info.name)
  let range = requireRange(op.range)
  if (range.top === range.bottom && range.left === range.right) {
    range = currentRegion(data, { row: range.top, col: range.left })
  }
  const hasHeaders = op.hasHeaders !== false
  const headerOccupied = Array.from({ length: range.right - range.left + 1 }, (_, i) => {
    const c = data.cells.get(cellKey(range.top, range.left + i))
    return !!c && (c.value !== null || c.formula !== null)
  }).some(Boolean)

  if (!hasHeaders && headerOccupied) {
    if (range.bottom + 1 >= MAX_ROWS)
      throw new XlsxError('Moving cells down for a table header would go past the end of the sheet.')
    for (let col = range.left; col <= range.right; col++) {
      const below = data.cells.get(cellKey(range.bottom + 1, col))
      if (below && (below.value !== null || below.formula !== null))
        throw new XlsxError(
          `Cannot shift cells down to make room for headers: ${cellName({ row: range.bottom + 1, col })} is not empty.`,
        )
    }
    checkNoOverlap(wb, info, { ...range, bottom: range.bottom + 1 })
    for (let r = range.bottom; r >= range.top; r--) {
      for (let col = range.left; col <= range.right; col++) {
        const cur = data.cells.get(cellKey(r, col))
        if (!cur || (cur.value === null && cur.formula === null)) {
          writeCell(wb, doc, r + 1, col, { kind: 'clear' }, cur?.style)
        } else if (cur.formula !== null) {
          const from = cellName({ row: r, col })
          const to = cellName({ row: r + 1, col })
          writeCell(wb, doc, r + 1, col, { kind: 'formula', formula: translateFormula(cur.formula, from, to) }, cur.style)
        } else if (cur.value !== null) {
          writeCell(wb, doc, r + 1, col, { kind: 'value', value: cur.value }, cur.style)
        }
        writeCell(wb, doc, r, col, { kind: 'clear' }, cur?.style)
      }
    }
    range = { ...range, bottom: range.bottom + 1 }
    wb.forgetSheet(info.part)
  } else if (range.bottom === range.top) {
    if (range.bottom + 1 >= MAX_ROWS)
      throw new XlsxError('A table needs at least one data row below the header.')
    range = { ...range, bottom: range.top + 1 }
  }

  // Check identical sheet autofilter: if exact match, migrate filter criteria into the table cleanly.
  const rootEl = doc.documentElement!
  const sheetAfEl = kid(rootEl, 'autoFilter')
  const sheetAfRange = sheetAfEl ? parseRange(sheetAfEl.getAttribute('ref') ?? '') : null
  const migrateSheetFilter = !!sheetAfRange && sameRange(sheetAfRange, range)

  checkNoOverlap(wb, info, range, { ignoreAutoFilter: migrateSheetFilter })

  const styleName = op.style ?? 'TableStyleMedium2'
  if (!isBuiltinTableStyle(styleName))
    throw new XlsxError(`Unknown built-in table style “${styleName}”.`)

  const tableName = op.name !== undefined ? checkTableName(wb, op.name) : nextDefaultTableName(wb)
  const rawCols: string[] = []
  for (let col = range.left; col <= range.right; col++) {
    rawCols.push(hasHeaders ? cellHeaderText(wb, info.name, range.top, col) : '')
  }
  const colNames = uniqueColumnNames(rawCols)
  for (let i = 0; i < colNames.length; i++) {
    const col = range.left + i
    const cur = wb.sheet(info.name).cells.get(cellKey(range.top, col))
    if (!hasHeaders || rawCols[i]!.trim() === '') {
      writeCell(wb, doc, range.top, col, { kind: 'value', value: colNames[i]! }, cur?.style)
    }
  }

  let nextId = 1
  for (const t of readWorkbookTables(wb)) nextId = Math.max(nextId, t.id + 1)
  let partNum = nextId
  while (wb.pkg.has(`/xl/tables/table${partNum}.xml`)) partNum++
  const part = `/xl/tables/table${partNum}.xml`

  const migratedAf = migrateSheetFilter ? readAutoFilterEl(sheetAfEl) : null
  if (migrateSheetFilter && sheetAfEl) {
    rootEl.removeChild(sheetAfEl)
    const wbRoot = wb.pkg.xml(wb.part).documentElement!
    const namesEl = kid(wbRoot, 'definedNames')
    const filterDef = namesEl
      ? kids(namesEl, 'definedName').find(
          (n) =>
            n.getAttribute('name') === '_xlnm._FilterDatabase' &&
            n.getAttribute('localSheetId') === String(info.index),
        )
      : undefined
    if (filterDef) {
      const wbDoc = wb.edit(wb.part)
      const nm = kid(wbDoc.documentElement!, 'definedNames')!
      nm.removeChild(filterDef)
      if (kids(nm, 'definedName').length === 0) wbDoc.documentElement!.removeChild(nm)
    }
  }

  const autoFilter = op.autoFilter === false ? null : (migratedAf ?? { range, columns: [] })
  const xml = buildTableXml({
    id: nextId,
    name: tableName,
    ref: range,
    headerRowCount: 1,
    totalsRowCount: 0,
    autoFilter,
    columns: colNames.map((n, idx) => ({ id: idx + 1, name: n })),
    style: {
      name: styleName,
      showFirstColumn: false,
      showLastColumn: false,
      showRowStripes: true,
      showColumnStripes: false,
    },
  })
  wb.write(part, strToU8(xml), CT_TABLE)

  if (migrateSheetFilter && migratedAf && migratedAf.columns.length > 0) {
    // Re-attach preserved filterColumn children to the newly written table XML.
    const tDoc = wb.edit(part)
    const tAf = kid(tDoc.documentElement!, 'autoFilter')
    if (tAf) {
      for (const fc of kids(sheetAfEl!, 'filterColumn')) {
        tAf.appendChild(tDoc.importNode(fc, true))
      }
    }
  }

  wb.touch(relsPartOf(info.part))
  const relId = wb.pkg.addRelationship(info.part, REL_TABLE, `../tables/table${partNum}.xml`)
  let tpEl = kid(rootEl, 'tableParts')
  if (!tpEl) {
    tpEl = make(doc, 'tableParts')
    insertInOrder(rootEl, tpEl, WORKSHEET_ORDER)
  }
  const partEl = make(doc, 'tablePart')
  if (!rootEl.lookupPrefix(NS_R)) rootEl.setAttribute('xmlns:r', NS_R)
  const rPrefix = rootEl.lookupPrefix(NS_R) ?? 'r'
  partEl.setAttributeNS(NS_R, `${rPrefix}:id`, relId)
  tpEl.appendChild(partEl)
  tpEl.setAttribute('count', String(kids(tpEl, 'tablePart').length))
  wb.forgetSheet(info.part)
  return { sheets: [info.name], table: tableName }
}

function applyColumnTotalCell(
  wb: Workbook,
  info: SheetInfo,
  sheetXml: XMLDocument,
  tableName: string,
  colSpec: TableColumnSpec,
  totalsRow: number,
  col: number,
  upd: TotalsColumnUpdate,
) {
  colSpec.totalsRowFunction = undefined
  colSpec.totalsRowLabel = undefined
  colSpec.totalsRowFormula = undefined
  const curStyle = wb.sheet(info.name).cells.get(cellKey(totalsRow, col))?.style
  if (upd.label !== undefined && upd.function === 'none') {
    colSpec.totalsRowLabel = upd.label
    writeCell(wb, sheetXml, totalsRow, col, { kind: 'value', value: upd.label }, curStyle)
    return
  }
  if (upd.function === 'none') {
    writeCell(wb, sheetXml, totalsRow, col, { kind: 'clear' }, curStyle)
    return
  }
  if (upd.function === 'custom') {
    const f = (upd.formula ?? '').replace(/^=/, '').trim()
    if (!f) throw new XlsxError(`Column “${colSpec.name}” custom total needs a formula.`)
    colSpec.totalsRowFunction = 'custom'
    colSpec.totalsRowFormula = f
    writeCell(wb, sheetXml, totalsRow, col, { kind: 'formula', formula: f }, curStyle)
    return
  }
  const code = TOTALS_SUBTOTAL[upd.function]
  if (!code) throw new XlsxError(`Unsupported table total function “${upd.function}”.`)
  colSpec.totalsRowFunction = upd.function
  const f = `SUBTOTAL(${code},${tableName}[${escapeStructCol(colSpec.name)}])`
  writeCell(wb, sheetXml, totalsRow, col, { kind: 'formula', formula: f }, curStyle)
}

export function updateTable(wb: Workbook, op: UpdateTableOp): { sheets: string[]; table: string } {
  const info = wb.requireWorksheet(op.sheet)
  const existing = findTable(wb, info.name, op.table)
  const sheetXml = wb.edit(info.part)
  normalizeRefs(sheetXml)
  const tDoc = wb.edit(existing.part)
  const tRoot = tDoc.documentElement!

  let name = existing.displayName
  let ref = { ...existing.ref }
  let headerRowCount = existing.headerRowCount
  let totalsRowCount = existing.totalsRowCount
  const style: TableStyleOptions = { ...existing.style }
  let columns = existing.columns.map((c) => ({ ...c }))

  if (op.name !== undefined && op.name.trim().toLowerCase() !== existing.displayName.toLowerCase()) {
    name = checkTableName(wb, op.name, existing.part)
    tRoot.setAttribute('name', name)
    tRoot.setAttribute('displayName', name)
    rewriteWorkbookFormulas(wb, (f) => renameTableRefsInFormula(f, existing.displayName, name))
  }

  if (op.ref !== undefined) {
    const nextRef = requireRange(op.ref)
    const minRows = Math.max(1, headerRowCount + totalsRowCount + 1)
    if (nextRef.bottom - nextRef.top + 1 < minRows)
      throw new XlsxError(
        `Table “${name}” needs at least ${minRows} rows to hold its header, data and totals rows.`,
      )
    checkNoOverlap(wb, info, nextRef, { ignoreTablePart: existing.part })
    if (existing.autoFilter) clearTableFilterRows(sheetXml, existing)
    ref = nextRef
    const colCount = ref.right - ref.left + 1
    let nextId = Math.max(0, ...columns.map((c) => c.id)) + 1
    const rawNames: string[] = []
    for (let i = 0; i < colCount; i++) {
      const curCol = columns[i]
      if (headerRowCount > 0) {
        const hdr = cellHeaderText(wb, info.name, ref.top, ref.left + i)
        rawNames.push(hdr || curCol?.name || '')
      } else {
        rawNames.push(curCol?.name || `Column${i + 1}`)
      }
    }
    const dedup = uniqueColumnNames(rawNames)
    columns = dedup.map((colNameStr, i) => {
      const prev = columns[i]
      if (headerRowCount > 0 && rawNames[i] === '') {
        const curStyle = wb.sheet(info.name).cells.get(cellKey(ref.top, ref.left + i))?.style
        writeCell(wb, sheetXml, ref.top, ref.left + i, { kind: 'value', value: colNameStr }, curStyle)
      }
      return prev
        ? { ...prev, name: colNameStr }
        : { id: nextId++, name: colNameStr }
    })
  }

  if (op.headerRow !== undefined) {
    const want = op.headerRow ? 1 : 0
    if (want !== headerRowCount) {
      if (want === 0 && existing.autoFilter) clearTableFilterRows(sheetXml, existing)
      headerRowCount = want
      tRoot.setAttribute('headerRowCount', String(want))
      if (want === 1) {
        const raw = columns.map((c, i) => cellHeaderText(wb, info.name, ref.top, ref.left + i) || c.name)
        const dedup = uniqueColumnNames(raw)
        columns = columns.map((c, i) => {
          if (cellHeaderText(wb, info.name, ref.top, ref.left + i) === '') {
            const curStyle = wb.sheet(info.name).cells.get(cellKey(ref.top, ref.left + i))?.style
            writeCell(wb, sheetXml, ref.top, ref.left + i, { kind: 'value', value: dedup[i]! }, curStyle)
          }
          return { ...c, name: dedup[i]! }
        })
      }
    }
  }

  if (op.totalsRow !== undefined) {
    const want = op.totalsRow ? 1 : 0
    if (want === 1 && totalsRowCount === 0) {
      const newBottom = ref.bottom + 1
      if (newBottom >= MAX_ROWS)
        throw new XlsxError('Adding a totals row would go past the end of the sheet.')
      const totalsSlice: Range = { top: newBottom, bottom: newBottom, left: ref.left, right: ref.right }
      const d = wb.sheet(info.name)
      for (let c = ref.left; c <= ref.right; c++) {
        const existingCell = d.cells.get(cellKey(newBottom, c))
        if (existingCell && (existingCell.value !== null || existingCell.formula !== null))
          throw new XlsxError(
            `Cannot add totals row: ${cellName({ row: newBottom, col: c })} is not empty.`,
          )
      }
      checkNoOverlap(wb, info, totalsSlice, { ignoreTablePart: existing.part })
      ref = { ...ref, bottom: newBottom }
      totalsRowCount = 1
      tRoot.setAttribute('totalsRowCount', '1')
      if (!op.totalsColumns || op.totalsColumns.length === 0) {
        const firstCol = columns[0]!
        applyColumnTotalCell(wb, info, sheetXml, name, firstCol, newBottom, ref.left, {
          column: 0,
          function: 'none',
          label: 'Total',
        })
        if (columns.length > 1) {
          const lastIdx = columns.length - 1
          applyColumnTotalCell(wb, info, sheetXml, name, columns[lastIdx]!, newBottom, ref.left + lastIdx, {
            column: lastIdx,
            function: 'sum',
          })
        }
      }
    } else if (want === 0 && totalsRowCount === 1) {
      const oldBottom = ref.bottom
      for (let c = ref.left; c <= ref.right; c++) {
        const st = wb.sheet(info.name).cells.get(cellKey(oldBottom, c))?.style
        writeCell(wb, sheetXml, oldBottom, c, { kind: 'clear' }, st)
      }
      ref = { ...ref, bottom: Math.max(ref.top, oldBottom - 1) }
      totalsRowCount = 0
      tRoot.removeAttribute('totalsRowCount')
    }
  }

  if (op.totalsColumns && op.totalsColumns.length > 0) {
    if (totalsRowCount === 0)
      throw new XlsxError(`Enable the totals row on “${name}” before editing column totals.`)
    for (const upd of op.totalsColumns) {
      const idx =
        typeof upd.column === 'number'
          ? upd.column
          : columns.findIndex((c) => c.name.toLowerCase() === String(upd.column).trim().toLowerCase())
      if (idx < 0 || idx >= columns.length)
        throw new XlsxError(`Table “${name}” has no column “${String(upd.column)}”.`)
      applyColumnTotalCell(wb, info, sheetXml, name, columns[idx]!, ref.bottom, ref.left + idx, upd)
    }
  }

  tRoot.setAttribute('ref', rangeName(ref))
  writeTableColumnsEl(tDoc, tRoot, columns)

  const existingAf = kid(tRoot, 'autoFilter')
  if (op.autoFilter === false || headerRowCount === 0) {
    if (existingAf) {
      clearTableFilterRows(sheetXml, { ...existing, autoFilter: readAutoFilterEl(existingAf) })
      tRoot.removeChild(existingAf)
    }
  } else if (op.autoFilter === true || existingAf) {
    const target = { ...ref, bottom: Math.max(ref.top, ref.bottom - totalsRowCount) }
    const afEl = existingAf ?? make(tDoc, 'autoFilter')
    afEl.setAttribute('ref', rangeName(target))
    if (!existingAf) insertInOrder(tRoot, afEl, TABLE_CHILD_ORDER)
  }

  if (op.style !== undefined) {
    if (!isBuiltinTableStyle(op.style))
      throw new XlsxError(`Unknown built-in table style “${op.style}”.`)
    style.name = op.style
  }
  if (op.showFirstColumn !== undefined) style.showFirstColumn = op.showFirstColumn
  if (op.showLastColumn !== undefined) style.showLastColumn = op.showLastColumn
  if (op.showRowStripes !== undefined) style.showRowStripes = op.showRowStripes
  if (op.showColumnStripes !== undefined) style.showColumnStripes = op.showColumnStripes
  writeTableStyleEl(tDoc, tRoot, style)

  wb.forgetSheet(info.part)
  return { sheets: [info.name], table: name }
}

export function deleteTable(wb: Workbook, op: DeleteTableOp): { sheets: string[] } {
  const info = wb.requireWorksheet(op.sheet)
  const t = findTable(wb, info.name, op.table)
  const mode = op.mode ?? 'convert_to_range'
  const sheetXml = wb.edit(info.part)
  normalizeRefs(sheetXml)

  clearTableFilterRows(sheetXml, t)
  rewriteWorkbookFormulas(wb, (f, home, addr) =>
    convertTableRefsInFormula(f, home, addr, t, mode),
  )

  if (mode === 'delete_cells') {
    for (let r = t.ref.top; r <= t.ref.bottom; r++) {
      for (let c = t.ref.left; c <= t.ref.right; c++) writeCell(wb, sheetXml, r, c, { kind: 'clear' }, 0)
    }
  }

  const tpEl = kid(sheetXml.documentElement!, 'tableParts')
  if (tpEl) {
    for (const p of kids(tpEl, 'tablePart')) {
      if (p.getAttributeNS(NS_R, 'id') === t.relId || p.getAttribute('r:id') === t.relId)
        tpEl.removeChild(p)
    }
    const left = kids(tpEl, 'tablePart').length
    if (left === 0) sheetXml.documentElement!.removeChild(tpEl)
    else tpEl.setAttribute('count', String(left))
  }

  const relsPath = relsPartOf(info.part)
  if (wb.pkg.has(relsPath)) {
    const relsDoc = wb.edit(relsPath)
    for (const r of kids(
      relsDoc.documentElement!,
      'Relationship',
      'http://schemas.openxmlformats.org/package/2006/relationships',
    )) {
      if (r.getAttribute('Id') === t.relId) relsDoc.documentElement!.removeChild(r)
    }
  }
  wb.remove(t.part)
  wb.forgetSheet(info.part)
  return { sheets: [info.name] }
}

/**
 * Expands tables on `info` when typing non-empty values immediately below the
 * last data row (when there is no totals row) or immediately to the right.
 */
export function autoExpandTables(
  wb: Workbook,
  info: SheetInfo,
  sheetXml: XMLDocument,
  writes: Array<{ row: number; col: number; text: string | null }>,
) {
  if (writes.length === 0) return
  const tables = readSheetTables(wb, info.name)
  if (tables.length === 0) return
  const sorted = [...writes].sort((a, b) => a.row - b.row || a.col - b.col)
  for (const t of tables) {
    let ref = { ...t.ref }
    let changed = false
    const columns = t.columns.map((c) => ({ ...c }))
    let nextId = Math.max(0, ...columns.map((c) => c.id)) + 1
    let didColExpand = true
    while (didColExpand) {
      didColExpand = false
      for (const w of sorted) {
        if (w.row >= ref.top && w.row <= ref.bottom && w.col === ref.right + 1) {
          const candidate = { ...ref, right: ref.right + 1 }
          if (!canAutoExpandTo(wb, info, t.part, { ...candidate, left: candidate.right })) continue
          ref = candidate
          changed = true
          didColExpand = true
          const existingHeader =
            t.headerRowCount > 0
              ? w.row === ref.top && w.text
                ? w.text.trim()
                : cellHeaderText(wb, info.name, ref.top, ref.right)
              : ''
          const used = new Set(columns.map((c) => c.name.toLowerCase()))
          let colTitle = existingHeader
          if (!colTitle) {
            let n = columns.length + 1
            while (used.has(`column${n}`)) n++
            colTitle = `Column${n}`
          } else {
            let s = 2
            const base = colTitle
            while (used.has(colTitle.toLowerCase())) colTitle = `${base}${s++}`
          }
          columns.push({ id: nextId++, name: colTitle })
          if (t.headerRowCount > 0 && (!existingHeader || w.row !== ref.top)) {
            const st = wb.sheet(info.name).cells.get(cellKey(ref.top, ref.right))?.style
            writeCell(wb, sheetXml, ref.top, ref.right, { kind: 'value', value: colTitle }, st)
          }
          break
        }
      }
    }
    if (t.totalsRowCount === 0) {
      let didRowExpand = true
      while (didRowExpand) {
        didRowExpand = false
        for (const w of sorted) {
          if (w.row === ref.bottom + 1 && w.col >= ref.left && w.col <= ref.right) {
            const candidate = { ...ref, bottom: ref.bottom + 1 }
            if (!canAutoExpandTo(wb, info, t.part, { ...candidate, top: candidate.bottom })) continue
            ref = candidate
            changed = true
            didRowExpand = true
            break
          }
        }
      }
    }
    if (!changed) continue
    const tDoc = wb.edit(t.part)
    const tRoot = tDoc.documentElement!
    tRoot.setAttribute('ref', rangeName(ref))
    writeTableColumnsEl(tDoc, tRoot, columns)
    const afEl = kid(tRoot, 'autoFilter')
    if (afEl && t.headerRowCount > 0)
      afEl.setAttribute('ref', rangeName({ ...ref, bottom: Math.max(ref.top, ref.bottom - t.totalsRowCount) }))
  }
}

function canAutoExpandTo(wb: Workbook, info: SheetInfo, selfPart: string, slice: Range): boolean {
  if (wb.sheet(info.name).merges.some((m) => rangesOverlap(m, slice))) return false
  for (const other of readSheetTables(wb, info.name)) {
    if (other.part !== selfPart && rangesOverlap(other.ref, slice)) return false
  }
  if (pivotRangesOnSheet(wb, info).some((p) => rangesOverlap(p.range, slice))) return false
  const afEl = kid(wb.pkg.xml(info.part).documentElement!, 'autoFilter')
  const af = afEl ? parseRange(afEl.getAttribute('ref') ?? '') : null
  if (af && rangesOverlap(af, slice)) return false
  return true
}
