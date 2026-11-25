import { strToU8 } from 'fflate'
import { relsPartOf } from '../ooxml/package'
import { createCalc } from './calc'
import { Unsupported } from './calc-values'
import {
  computePivot,
  defaultDataFieldName,
  isPivotAgg,
  itemKey,
  type PivotAgg,
  type PivotCalcResult,
  type PivotPageField,
  type PivotTupleMeta,
  type PivotValueField,
} from './pivot-calc'
import {
  cellKey,
  parseRange,
  rangeName,
  requireCell,
  type Range,
} from './ref'
import {
  currentRegion,
  normalizeRefs,
  writeCell,
} from './sheet-xml'
import { xfWithNumFmt, type BorderEdge } from './styles'
import { readSheetTables, readWorkbookTables, type TableCellLook } from './tables'
import {
  isErrorValue,
  relativeTarget,
  XlsxError,
  type CellValue,
  type SheetInfo,
  type Workbook,
} from './workbook'
import {
  all,
  insertInOrder,
  kid,
  kids,
  make,
  NS_MAIN,
  NS_R,
  REL,
  WORKBOOK_ORDER,
} from './xml'

/**
 * Pivot Tables (ECMA-376 Part 1 §18.10, `xl/pivotTables/pivotTableN.xml` &
 * `xl/pivotCache/pivotCacheDefinitionN.xml` + `pivotCacheRecordsN.xml`):
 * rendering existing pivots in the grid, refreshing from source range or table,
 * creating from a selection, updating layout/filters/aggregations, deleting
 * with orphan cache cleanup, and evaluating `GETPIVOTDATA`.
 */

export const CT_PIVOT_TABLE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml'
export const CT_PIVOT_CACHE_DEF =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml'
export const CT_PIVOT_CACHE_REC =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml'

export const REL_PIVOT_TABLE = `${REL}pivotTable`
export const REL_PIVOT_CACHE_DEF = `${REL}pivotCacheDefinition`
export const REL_PIVOT_CACHE_REC = `${REL}pivotCacheRecords`

export const PIVOT_STYLES = [
  { id: 'PivotStyleLight16', label: 'Light Blue 16' },
  { id: 'PivotStyleLight9', label: 'Light Blue 9' },
  { id: 'PivotStyleMedium2', label: 'Medium Blue 2' },
  { id: 'PivotStyleMedium9', label: 'Medium Blue 9' },
  { id: 'PivotStyleMedium4', label: 'Medium Gray 4' },
  { id: 'PivotStyleMedium6', label: 'Medium Green 6' },
  { id: 'PivotStyleDark2', label: 'Dark Blue 2' },
] as const

export type PivotDataFieldInput = {
  field: string
  agg?: PivotAgg
  name?: string
  numFmt?: string
}

export type PivotTableInfo = {
  name: string
  sheet: string
  part: string
  relId: string
  cacheId: number
  cacheDefPart: string
  cacheRecordsPart: string | null
  sourceSheet: string
  sourceRef: string
  sourceTable?: string
  location: Range
  firstHeaderRow: number
  firstDataRow: number
  firstDataCol: number
  rowFields: string[]
  colFields: string[]
  pageFields: PivotPageField[]
  dataFields: PivotValueField[]
  hiddenItems: Record<string, string[]>
  fields: string[]
  fieldItems: Record<string, string[]>
  rowGrandTotals: boolean
  colGrandTotals: boolean
  subtotals: boolean
  styleName: string
}

export type CreatePivotOp = {
  op: 'create_pivot'
  sourceSheet?: string
  source: string
  targetSheet?: string
  targetCell?: string
  name?: string
  rowFields?: string[]
  colFields?: string[]
  pageFields?: PivotPageField[]
  dataFields?: PivotDataFieldInput[]
  rowGrandTotals?: boolean
  colGrandTotals?: boolean
  subtotals?: boolean
  style?: string
}

export type UpdatePivotOp = {
  op: 'update_pivot'
  sheet: string
  pivot: string
  name?: string
  rowFields?: string[]
  colFields?: string[]
  pageFields?: PivotPageField[]
  dataFields?: PivotDataFieldInput[]
  hiddenItems?: Record<string, string[]>
  rowGrandTotals?: boolean
  colGrandTotals?: boolean
  subtotals?: boolean
  style?: string
}

export type RefreshPivotOp = {
  op: 'refresh_pivot'
  sheet: string
  pivot: string
}

export type DeletePivotOp = {
  op: 'delete_pivot'
  sheet: string
  pivot: string
  keepValues?: boolean
}

export type PivotOp = CreatePivotOp | UpdatePivotOp | RefreshPivotOp | DeletePivotOp

export type PivotCellLook = TableCellLook

const rangesOverlap = (a: Range, b: Range) =>
  a.top <= b.bottom && b.top <= a.bottom && a.left <= b.right && b.left <= a.right

const boolAttr = (el: Element | null, attr: string, fallback: boolean): boolean => {
  const v = el?.getAttribute(attr)
  if (v === null || v === undefined) return fallback
  return v === '1' || v === 'true'
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ---------------------------------------------------------------------------
// Reading pivot tables & caches

function cacheDefByWorkbookId(wb: Workbook, cacheId: number): string | null {
  const wbRoot = wb.pkg.xml(wb.part).documentElement
  const caches = wbRoot ? kid(wbRoot, 'pivotCaches') : null
  if (!caches) return null
  const rels = new Map(wb.pkg.relationships(wb.part).map((r) => [r.id, r.part]))
  for (const pc of kids(caches, 'pivotCache')) {
    if (Number(pc.getAttribute('cacheId') ?? -1) === cacheId) {
      const rId = pc.getAttributeNS(NS_R, 'id') ?? pc.getAttribute('r:id') ?? ''
      const p = rels.get(rId)
      if (p && wb.pkg.has(p)) return p
    }
  }
  return null
}

function sharedItemValue(el: Element): CellValue {
  switch (el.localName) {
    case 's':
      return el.getAttribute('v') ?? ''
    case 'n': {
      const n = Number(el.getAttribute('v') ?? 0)
      return Number.isFinite(n) ? n : null
    }
    case 'b': {
      const v = el.getAttribute('v')
      return v === '1' || v === 'true'
    }
    case 'e':
      return { error: el.getAttribute('v') ?? '#VALUE!' }
    case 'd': {
      const iso = el.getAttribute('v') ?? ''
      const ms = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`)
      return Number.isNaN(ms) ? iso : ms / 86_400_000 + 25_569
    }
    default:
      return null
  }
}

type ParsedCache = {
  sourceSheet: string
  sourceRef: string
  sourceTable?: string
  fields: string[]
  sharedItems: CellValue[][]
  recordsPart: string | null
  records: Array<Record<string, CellValue>>
}

function readCache(wb: Workbook, cacheDefPart: string): ParsedCache {
  const doc = wb.pkg.xml(cacheDefPart)
  const root = doc.documentElement!
  const cs = kid(root, 'cacheSource')
  const ws = cs ? kid(cs, 'worksheetSource') : null
  const sourceSheet = ws?.getAttribute('sheet') ?? ''
  const sourceTable = ws?.getAttribute('name') ?? undefined
  const sourceRef = ws?.getAttribute('ref') ?? sourceTable ?? ''
  const cfEl = kid(root, 'cacheFields')
  const fields: string[] = []
  const sharedItems: CellValue[][] = []
  for (const cf of cfEl ? kids(cfEl, 'cacheField') : []) {
    fields.push(cf.getAttribute('name') ?? `Column${fields.length + 1}`)
    const siEl = kid(cf, 'sharedItems')
    const items = siEl ? kids(siEl, undefined).map(sharedItemValue) : []
    sharedItems.push(items)
  }
  const recRel = wb.pkg
    .relationships(cacheDefPart)
    .find((r) => !r.external && r.type === REL_PIVOT_CACHE_REC && r.part && wb.pkg.has(r.part))
  const recordsPart = recRel?.part ?? null
  const records: Array<Record<string, CellValue>> = []
  if (recordsPart) {
    const recRoot = wb.pkg.xml(recordsPart).documentElement
    for (const rEl of recRoot ? kids(recRoot, 'r') : []) {
      const rec: Record<string, CellValue> = {}
      const children = kids(rEl, undefined)
      for (let i = 0; i < fields.length; i++) {
        const ch = children[i]
        if (!ch) rec[fields[i]!] = null
        else if (ch.localName === 'x') {
          const idx = Number(ch.getAttribute('v') ?? -1)
          rec[fields[i]!] = sharedItems[i]?.[idx] ?? null
        } else {
          rec[fields[i]!] = sharedItemValue(ch)
        }
      }
      records.push(rec)
    }
  }
  return { sourceSheet, sourceRef, sourceTable, fields, sharedItems, recordsPart, records }
}

function parsePivotDoc(
  wb: Workbook,
  sheet: string,
  part: string,
  relId: string,
): PivotTableInfo | null {
  const doc = wb.pkg.xml(part)
  const root = doc.documentElement
  if (!root || root.localName !== 'pivotTableDefinition') return null
  const locEl = kid(root, 'location')
  const location = locEl ? parseRange(locEl.getAttribute('ref') ?? '') : null
  if (!location) return null

  const cacheId = Number(root.getAttribute('cacheId') ?? 0)
  const ptCacheRel = wb.pkg
    .relationships(part)
    .find((r) => !r.external && r.type === REL_PIVOT_CACHE_DEF && r.part && wb.pkg.has(r.part))
  const cacheDefPart = ptCacheRel?.part ?? cacheDefByWorkbookId(wb, cacheId)
  if (!cacheDefPart) return null

  const cache = readCache(wb, cacheDefPart)
  const fieldNameAt = (x: number) => cache.fields[x]

  const pfEl = kid(root, 'pivotFields')
  const pfNodes = pfEl ? kids(pfEl, 'pivotField') : []
  const hiddenItems: Record<string, string[]> = {}
  const fieldItems: Record<string, string[]> = {}
  let subtotals = false

  for (let i = 0; i < pfNodes.length; i++) {
    const fName = fieldNameAt(i)
    if (!fName) continue
    if (boolAttr(pfNodes[i]!, 'defaultSubtotal', true)) subtotals = true
    const si = cache.sharedItems[i] ?? []
    fieldItems[fName] = si.map((v) => itemKey(v))
    const itemsEl = kid(pfNodes[i]!, 'items')
    const hidden: string[] = []
    for (const itemEl of itemsEl ? kids(itemsEl, 'item') : []) {
      if (!boolAttr(itemEl, 'h', false)) continue
      const t = itemEl.getAttribute('t')
      if (t) continue
      const x = itemEl.getAttribute('x')
      const n = itemEl.getAttribute('n')
      if (x !== null && si[Number(x)] !== undefined) hidden.push(itemKey(si[Number(x)]!))
      else if (n !== null) hidden.push(n)
    }
    if (hidden.length > 0) hiddenItems[fName] = hidden
  }

  const readFieldAxis = (tag: 'rowFields' | 'colFields'): string[] => {
    const el = kid(root, tag)
    if (!el) return []
    const out: string[] = []
    for (const f of kids(el, 'field')) {
      const idx = Number(f.getAttribute('x'))
      if (idx === -2) continue // Data / Values pseudo-field
      const fn = fieldNameAt(idx)
      if (fn) out.push(fn)
    }
    return out
  }

  const pageFields: PivotPageField[] = []
  const pageEl = kid(root, 'pageFields')
  for (const pf of pageEl ? kids(pageEl, 'pageField') : []) {
    const idx = Number(pf.getAttribute('fld') ?? -1)
    const fn = fieldNameAt(idx)
    if (!fn) continue
    const itemIdx = pf.getAttribute('item')
    const si = cache.sharedItems[idx] ?? []
    const selectedItem =
      itemIdx !== null && Number(itemIdx) >= 0 && si[Number(itemIdx)] !== undefined
        ? itemKey(si[Number(itemIdx)]!)
        : undefined
    pageFields.push(selectedItem !== undefined ? { field: fn, selectedItem } : { field: fn })
  }

  const dataFields: PivotValueField[] = []
  const dfEl = kid(root, 'dataFields')
  const numFmts = wb.styles()
  for (const df of dfEl ? kids(dfEl, 'dataField') : []) {
    const idx = Number(df.getAttribute('fld') ?? -1)
    const fn = fieldNameAt(idx)
    if (!fn) continue
    const rawAgg = df.getAttribute('subtotal') ?? 'sum'
    const agg: PivotAgg = isPivotAgg(rawAgg) ? rawAgg : 'sum'
    const name = df.getAttribute('name') ?? defaultDataFieldName(fn, agg)
    const numFmtId = df.getAttribute('numFmtId')
    const numFmt = numFmtId !== null ? numFmts.numFmtCode(Number(numFmtId)) : undefined
    dataFields.push({
      field: fn,
      agg,
      name,
      ...(numFmt && numFmt !== 'General' ? { numFmt } : {}),
    })
  }

  const styleEl = kid(root, 'pivotTableStyleInfo')
  return {
    name: root.getAttribute('name') ?? 'PivotTable1',
    sheet,
    part,
    relId,
    cacheId,
    cacheDefPart,
    cacheRecordsPart: cache.recordsPart,
    sourceSheet: cache.sourceSheet,
    sourceRef: cache.sourceRef,
    ...(cache.sourceTable ? { sourceTable: cache.sourceTable } : {}),
    location,
    firstHeaderRow: Number(locEl?.getAttribute('firstHeaderRow') ?? 1),
    firstDataRow: Number(locEl?.getAttribute('firstDataRow') ?? 1),
    firstDataCol: Number(locEl?.getAttribute('firstDataCol') ?? 1),
    rowFields: readFieldAxis('rowFields'),
    colFields: readFieldAxis('colFields'),
    pageFields,
    dataFields,
    hiddenItems,
    fields: cache.fields,
    fieldItems,
    rowGrandTotals: boolAttr(root, 'rowGrandTotals', true),
    colGrandTotals: boolAttr(root, 'colGrandTotals', true),
    subtotals,
    styleName: styleEl?.getAttribute('name') ?? 'PivotStyleLight16',
  }
}

export function readSheetPivots(wb: Workbook, sheet: string): PivotTableInfo[] {
  const info = wb.requireWorksheet(sheet)
  const out: PivotTableInfo[] = []
  for (const rel of wb.pkg.relationships(info.part)) {
    if (rel.external || rel.type !== REL_PIVOT_TABLE || !rel.part || !wb.pkg.has(rel.part)) continue
    const p = parsePivotDoc(wb, info.name, rel.part, rel.id)
    if (p) out.push(p)
  }
  return out
}

export function readWorkbookPivots(wb: Workbook): PivotTableInfo[] {
  const out: PivotTableInfo[] = []
  for (const s of wb.sheets()) {
    if (s.kind !== 'worksheet') continue
    out.push(...readSheetPivots(wb, s.name))
  }
  return out
}

export function findPivot(wb: Workbook, sheet: string, name: string): PivotTableInfo {
  const key = name.trim().toLowerCase()
  const hit = readSheetPivots(wb, sheet).find((p) => p.name.toLowerCase() === key)
  if (!hit) throw new XlsxError(`Sheet “${sheet}” has no pivot table named “${name}”.`)
  return hit
}

export function pivotAtCell(
  wb: Workbook,
  sheet: string,
  row: number,
  col: number,
): PivotTableInfo | null {
  return (
    readSheetPivots(wb, sheet).find(
      (p) =>
        row >= p.location.top &&
        row <= p.location.bottom &&
        col >= p.location.left &&
        col <= p.location.right,
    ) ?? null
  )
}

export function pivotSummary(p: PivotTableInfo) {
  return {
    name: p.name,
    location: rangeName(p.location),
    source: p.sourceTable
      ? p.sourceTable
      : p.sourceSheet
        ? `${p.sourceSheet}!${p.sourceRef}`
        : p.sourceRef,
    rows: p.rowFields,
    columns: p.colFields,
    filters: p.pageFields,
    values: p.dataFields.map((d) => ({ field: d.field, agg: d.agg, name: d.name })),
  }
}

// ---------------------------------------------------------------------------
// Grid rendering looks for pivot tables

function pivotPalette(styleName: string): {
  headerFill: string
  headerColor: string
  subtotalFill: string
  totalFill: string
  accent: string
} {
  const lower = styleName.toLowerCase()
  if (lower.includes('dark')) {
    return {
      headerFill: '#1F4E78',
      headerColor: '#FFFFFF',
      subtotalFill: '#D9E1F2',
      totalFill: '#B4C6E7',
      accent: '#1F4E78',
    }
  }
  if (lower.includes('medium4') || lower.includes('gray')) {
    return {
      headerFill: '#A5A5A5',
      headerColor: '#FFFFFF',
      subtotalFill: '#EDEDED',
      totalFill: '#D9D9D9',
      accent: '#808080',
    }
  }
  if (lower.includes('medium6') || lower.includes('green')) {
    return {
      headerFill: '#70AD47',
      headerColor: '#FFFFFF',
      subtotalFill: '#E2EFDA',
      totalFill: '#C6E0B4',
      accent: '#548235',
    }
  }
  if (lower.includes('medium')) {
    return {
      headerFill: '#4472C4',
      headerColor: '#FFFFFF',
      subtotalFill: '#D9E1F2',
      totalFill: '#B4C6E7',
      accent: '#2F5597',
    }
  }
  return {
    headerFill: '#D9E1F2',
    headerColor: '#000000',
    subtotalFill: '#EDF2F8',
    totalFill: '#D9E1F2',
    accent: '#4472C4',
  }
}

export function pivotCellLook(
  wb: Workbook,
  pivots: readonly PivotTableInfo[],
  row: number,
  col: number,
): PivotCellLook | null {
  for (const p of pivots) {
    const loc = p.location
    if (row < loc.top || row > loc.bottom || col < loc.left || col > loc.right) continue
    const pal = pivotPalette(p.styleName)
    const relRow = row - loc.top
    const relCol = col - loc.left
    const data = wb.sheet(p.sheet)
    const cellText = String(data.cells.get(cellKey(row, col))?.value ?? '')

    // Page filter region above pivot headers
    if (relRow < p.firstHeaderRow) {
      if (relRow < p.pageFields.length && relCol <= 1) {
        return {
          fill: '#F2F4F8',
          bold: relCol === 0,
          borderBottom: { style: 'thin', color: '#D0D7DE' },
        }
      }
      return null
    }

    // Header rows
    if (relRow >= p.firstHeaderRow && relRow < p.firstDataRow) {
      return {
        fill: pal.headerFill,
        color: pal.headerColor,
        bold: true,
        borderBottom: { style: 'thin', color: pal.accent },
      }
    }

    // Grand total bottom row
    if (p.colGrandTotals && row === loc.bottom && relRow >= p.firstDataRow) {
      const top: BorderEdge = { style: 'thin', color: pal.accent }
      const bottom: BorderEdge = { style: 'double', color: pal.accent }
      return {
        fill: pal.totalFill,
        bold: true,
        borderTop: top,
        borderBottom: bottom,
      }
    }

    // Grand total right column
    if (
      p.rowGrandTotals &&
      p.colFields.length > 0 &&
      col >= loc.right - Math.max(0, p.dataFields.length - 1) &&
      relCol >= p.firstDataCol
    ) {
      return { bold: true }
    }

    // Check if row is a subtotal row (left labels contain " Total")
    for (let c = loc.left; c < loc.left + p.firstDataCol; c++) {
      const label = String(data.cells.get(cellKey(row, c))?.value ?? '')
      if (label.endsWith(' Total')) {
        return {
          fill: pal.subtotalFill,
          bold: true,
          borderTop: { style: 'thin', color: pal.accent },
        }
      }
    }

    if (relCol === 0 && cellText !== '' && p.rowFields.length > 1) {
      return { bold: true }
    }
    return null
  }
  return null
}

// ---------------------------------------------------------------------------
// Source reading & XML writing

type LiveSource = {
  sourceSheet: string
  sourceRef: string
  sourceTable?: string
  fields: string[]
  records: Array<Record<string, CellValue>>
  sharedItems: CellValue[][]
}

function uniqueFields(raw: string[]): string[] {
  const used = new Set<string>()
  const out: string[] = []
  let idx = 1
  for (const r of raw) {
    let base = r.trim()
    if (!base) {
      while (used.has(`column${idx}`)) idx++
      base = `Column${idx++}`
    }
    let name = base
    let s = 2
    while (used.has(name.toLowerCase())) name = `${base}${s++}`
    used.add(name.toLowerCase())
    out.push(name)
  }
  return out
}

function resolvePivotSource(
  wb: Workbook,
  defaultSheet: string | undefined,
  sourceText: string,
  sourceTable?: string,
  cellValFn?: (sheet: string, row: number, col: number) => CellValue,
): LiveSource {
  let sheetName: string
  let refRange: Range
  let resolvedTableName = sourceTable

  const tblHit = readWorkbookTables(wb).find(
    (t) =>
      t.displayName.toLowerCase() === (sourceTable ?? sourceText).trim().toLowerCase() ||
      t.name.toLowerCase() === (sourceTable ?? sourceText).trim().toLowerCase(),
  )
  if (tblHit) {
    sheetName = tblHit.sheet
    resolvedTableName = tblHit.displayName
    refRange = {
      ...tblHit.ref,
      bottom: Math.max(tblHit.ref.top + tblHit.headerRowCount, tblHit.ref.bottom - tblHit.totalsRowCount),
    }
  } else {
    const bang = sourceText.lastIndexOf('!')
    const rawSheet = bang > 0 ? sourceText.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'") : defaultSheet
    const rawRef = bang > 0 ? sourceText.slice(bang + 1) : sourceText
    if (!rawSheet)
      throw new XlsxError('Pivot source needs a sheet name (e.g. Sales!A1:D20) or table name.')
    sheetName = wb.requireWorksheet(rawSheet).name
    const parsed = parseRange(rawRef)
    if (!parsed) throw new XlsxError(`Invalid pivot source range “${sourceText}”.`)
    if (parsed.top === parsed.bottom && parsed.left === parsed.right) {
      refRange = currentRegion(wb.sheet(sheetName), { row: parsed.top, col: parsed.left })
    } else {
      refRange = parsed
    }
  }

  if (refRange.bottom <= refRange.top)
    throw new XlsxError(`Pivot source ${sheetName}!${rangeName(refRange)} needs a header row and at least one data row.`)

  const sheetData = wb.sheet(sheetName)
  const calc = cellValFn ? null : createCalc(wb)
  const valAt = (r: number, c: number): CellValue => {
    const cell = sheetData.cells.get(cellKey(r, c))
    if (!cell || (cell.value === null && cell.formula === null)) return null
    return cellValFn ? cellValFn(sheetName, r, c) : calc!.cell(sheetName, r, c).value
  }

  const rawHeaders: string[] = []
  for (let c = refRange.left; c <= refRange.right; c++) {
    const v = valAt(refRange.top, c)
    rawHeaders.push(v === null || isErrorValue(v) ? '' : String(v))
  }
  const fields = uniqueFields(rawHeaders)
  const records: Array<Record<string, CellValue>> = []
  for (let r = refRange.top + 1; r <= refRange.bottom; r++) {
    const rec: Record<string, CellValue> = {}
    for (let i = 0; i < fields.length; i++) {
      rec[fields[i]!] = valAt(r, refRange.left + i)
    }
    records.push(rec)
  }

  // Build sharedItems per field (distinct values in source)
  const sharedItems: CellValue[][] = fields.map((f) => {
    const seen = new Map<string, CellValue>()
    for (const rec of records) {
      const v = rec[f] ?? null
      const k = itemKey(v)
      if (!seen.has(k)) seen.set(k, v)
    }
    return [...seen.values()]
  })

  return {
    sourceSheet: sheetName,
    sourceRef: rangeName(refRange),
    ...(resolvedTableName ? { sourceTable: resolvedTableName } : {}),
    fields,
    records,
    sharedItems,
  }
}

function encodeCacheItem(tagSuffix: string, v: CellValue): string {
  if (v === null || v === '') return '<m/>'
  if (typeof v === 'number') return `<n v="${v}"/>`
  if (typeof v === 'boolean') return `<b v="${v ? 1 : 0}"/>`
  if (isErrorValue(v)) return `<e v="${escXml(v.error)}"/>`
  void tagSuffix
  return `<s v="${escXml(String(v))}"/>`
}

function writeCacheXml(
  wb: Workbook,
  cacheDefPart: string,
  cacheRecordsPart: string,
  src: LiveSource,
) {
  const fieldsXml = src.fields
    .map((f, i) => {
      const items = src.sharedItems[i]!
      const siAttrs: string[] = []
      const hasStr = items.some((v) => typeof v === 'string')
      const hasNum = items.some((v) => typeof v === 'number')
      const hasBlank = items.some((v) => v === null || v === '')
      if (hasBlank) siAttrs.push('containsBlank="1"')
      if (hasStr) siAttrs.push('containsString="1"')
      if (hasNum) siAttrs.push('containsNumber="1"')
      const itemXml = items.map((v) => encodeCacheItem('si', v)).join('')
      return `<cacheField name="${escXml(f)}" numFmtId="0"><sharedItems ${siAttrs.join(' ')} count="${items.length}">${itemXml}</sharedItems></cacheField>`
    })
    .join('')

  const wsAttrs = [`ref="${src.sourceRef}"`, `sheet="${escXml(src.sourceSheet)}"`]
  if (src.sourceTable) wsAttrs.push(`name="${escXml(src.sourceTable)}"`)

  const rels = wb.pkg.relationships(cacheDefPart)
  let recRelId = rels.find((r) => r.type === REL_PIVOT_CACHE_REC && r.part === cacheRecordsPart)?.id
  if (!recRelId) {
    wb.touch(relsPartOf(cacheDefPart))
    recRelId = wb.pkg.addRelationship(
      cacheDefPart,
      REL_PIVOT_CACHE_REC,
      relativeTarget(cacheDefPart, cacheRecordsPart),
    )
  }

  const defXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<pivotCacheDefinition xmlns="${NS_MAIN}" xmlns:r="${NS_R}" r:id="${recRelId}" refreshOnLoad="1" refreshedVersion="8" createdVersion="8" recordCount="${src.records.length}">` +
    `<cacheSource type="worksheet"><worksheetSource ${wsAttrs.join(' ')}/></cacheSource>` +
    `<cacheFields count="${src.fields.length}">${fieldsXml}</cacheFields>` +
    `</pivotCacheDefinition>`

  const itemIndexMaps = src.sharedItems.map((list) => {
    const m = new Map<string, number>()
    list.forEach((v, idx) => m.set(itemKey(v), idx))
    return m
  })
  const recsXml = src.records
    .map((rec) => {
      const cells = src.fields
        .map((f, i) => {
          const idx = itemIndexMaps[i]!.get(itemKey(rec[f] ?? null))
          return idx !== undefined ? `<x v="${idx}"/>` : encodeCacheItem('rec', rec[f] ?? null)
        })
        .join('')
      return `<r>${cells}</r>`
    })
    .join('')
  const recordsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<pivotCacheRecords xmlns="${NS_MAIN}" xmlns:r="${NS_R}" count="${src.records.length}">${recsXml}</pivotCacheRecords>`

  wb.write(cacheRecordsPart, strToU8(recordsXml), CT_PIVOT_CACHE_REC)
  wb.write(cacheDefPart, strToU8(defXml), CT_PIVOT_CACHE_DEF)
}

function serializePivotItems(
  tuples: PivotTupleMeta[],
  fieldNames: string[],
  sharedItemsByField: Map<string, CellValue[]>,
): string {
  if (tuples.length === 0) return ''
  return tuples
    .map((t) => {
      if (t.type === 'grand') {
        const extra = t.dataFieldIndex !== undefined && t.dataFieldIndex > 0 ? ` i="${t.dataFieldIndex}"` : ''
        return `<i t="grand"${extra}><x v="0"/></i>`
      }
      const attrs: string[] = []
      if (t.type === 'subtotal') attrs.push('t="default"')
      if (t.dataFieldIndex !== undefined && t.dataFieldIndex > 0) attrs.push(`i="${t.dataFieldIndex}"`)
      const xs = t.keys
        .map((k, lvl) => {
          const fn = fieldNames[lvl]
          const si = fn ? (sharedItemsByField.get(fn) ?? []) : []
          const idx = si.findIndex((v) => itemKey(v) === k)
          return `<x v="${Math.max(0, idx)}"/>`
        })
        .join('')
      return `<i${attrs.length ? ` ${attrs.join(' ')}` : ''}>${xs}</i>`
    })
    .join('')
}

function writePivotTableXml(
  wb: Workbook,
  part: string,
  info: {
    name: string
    cacheId: number
    location: Range
    calc: PivotCalcResult
    fields: string[]
    sharedItems: CellValue[][]
    rowFields: string[]
    colFields: string[]
    pageFields: PivotPageField[]
    dataFields: PivotValueField[]
    hiddenItems: Record<string, string[]>
    rowGrandTotals: boolean
    colGrandTotals: boolean
    subtotals: boolean
    styleName: string
  },
) {
  const fieldIdx = new Map(info.fields.map((f, i) => [f.toLowerCase(), i]))
  const sharedMap = new Map(info.fields.map((f, i) => [f, info.sharedItems[i] ?? []]))
  const rowSet = new Set(info.rowFields.map((f) => f.toLowerCase()))
  const colSet = new Set(info.colFields.map((f) => f.toLowerCase()))
  const pageSet = new Set(info.pageFields.map((p) => p.field.toLowerCase()))
  const dataSet = new Set(info.dataFields.map((d) => d.field.toLowerCase()))

  const pivotFieldsXml = info.fields
    .map((f, i) => {
      const k = f.toLowerCase()
      const axes: string[] = []
      if (rowSet.has(k)) axes.push('axis="axisRow"')
      else if (colSet.has(k)) axes.push('axis="axisCol"')
      else if (pageSet.has(k)) axes.push('axis="axisPage"')
      if (dataSet.has(k)) axes.push('dataField="1"')
      if (!info.subtotals) axes.push('defaultSubtotal="0"')
      const si = info.sharedItems[i] ?? []
      const hidden = new Set((info.hiddenItems[f] ?? []).map((x) => x.toLowerCase()))
      const itemNodes = si.map((v, idx) => {
        const h = hidden.has(itemKey(v).toLowerCase()) ? ' h="1"' : ''
        return `<item x="${idx}"${h}/>`
      })
      if (info.subtotals) itemNodes.push('<item t="default"/>')
      const itemsXml =
        itemNodes.length > 0
          ? `<items count="${itemNodes.length}">${itemNodes.join('')}</items>`
          : ''
      return `<pivotField ${axes.join(' ')} showAll="0">${itemsXml}</pivotField>`
    })
    .join('')

  const rowFieldsIndices = info.rowFields.map((f) => fieldIdx.get(f.toLowerCase())!)
  const colFieldsIndices = info.colFields.map((f) => fieldIdx.get(f.toLowerCase())!)
  if (info.dataFields.length > 1) colFieldsIndices.push(-2)

  const rowFieldsXml =
    rowFieldsIndices.length > 0
      ? `<rowFields count="${rowFieldsIndices.length}">${rowFieldsIndices.map((x) => `<field x="${x}"/>`).join('')}</rowFields>`
      : ''
  const colFieldsXml =
    colFieldsIndices.length > 0
      ? `<colFields count="${colFieldsIndices.length}">${colFieldsIndices.map((x) => `<field x="${x}"/>`).join('')}</colFields>`
      : ''

  const rowItemsNodes = serializePivotItems(info.calc.rowTuples, info.rowFields, sharedMap)
  const rowItemsXml = rowItemsNodes
    ? `<rowItems count="${info.calc.rowTuples.length}">${rowItemsNodes}</rowItems>`
    : ''
  const colItemsNodes = serializePivotItems(info.calc.colTuples, info.colFields, sharedMap)
  const colItemsXml = colItemsNodes
    ? `<colItems count="${info.calc.colTuples.length}">${colItemsNodes}</colItems>`
    : ''

  const pageFieldsXml =
    info.pageFields.length > 0
      ? `<pageFields count="${info.pageFields.length}">${info.pageFields
          .map((pf) => {
            const idx = fieldIdx.get(pf.field.toLowerCase())!
            const si = info.sharedItems[idx] ?? []
            const itemIdx =
              pf.selectedItem && pf.selectedItem !== '(All)'
                ? si.findIndex((v) => itemKey(v).toLowerCase() === pf.selectedItem!.toLowerCase())
                : -1
            return `<pageField fld="${idx}"${itemIdx >= 0 ? ` item="${itemIdx}"` : ''} hier="-1"/>`
          })
          .join('')}</pageFields>`
      : ''

  const dataFieldsXml =
    info.dataFields.length > 0
      ? `<dataFields count="${info.dataFields.length}">${info.dataFields
          .map((df) => {
            const idx = fieldIdx.get(df.field.toLowerCase())!
            return `<dataField name="${escXml(df.name)}" fld="${idx}" subtotal="${df.agg}" baseField="0" baseItem="0"/>`
          })
          .join('')}</dataFields>`
      : ''

  const ptAttrs = [
    `xmlns="${NS_MAIN}"`,
    `name="${escXml(info.name)}"`,
    `cacheId="${info.cacheId}"`,
    `applyNumberFormats="0"`,
    `applyBorderFormats="0"`,
    `applyFontFormats="0"`,
    `applyPatternFormats="0"`,
    `applyAlignmentFormats="0"`,
    `applyWidthHeightFormats="1"`,
    `dataCaption="Values"`,
    `updatedVersion="8"`,
    `createdVersion="8"`,
    ...(info.rowGrandTotals ? [] : [`rowGrandTotals="0"`]),
    ...(info.colGrandTotals ? [] : [`colGrandTotals="0"`]),
  ]

  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<pivotTableDefinition ${ptAttrs.join(' ')}>` +
    `<location ref="${rangeName(info.location)}" firstHeaderRow="${info.calc.firstHeaderRow}" firstDataRow="${info.calc.firstDataRow}" firstDataCol="${info.calc.firstDataCol}" rowPageCount="${info.pageFields.length}" colPageCount="1"/>` +
    `<pivotFields count="${info.fields.length}">${pivotFieldsXml}</pivotFields>` +
    rowFieldsXml +
    rowItemsXml +
    colFieldsXml +
    colItemsXml +
    pageFieldsXml +
    dataFieldsXml +
    `<pivotTableStyleInfo name="${escXml(info.styleName)}" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/>` +
    `</pivotTableDefinition>`

  wb.write(part, strToU8(xml), CT_PIVOT_TABLE)
}

function validatePivotFieldConfig(
  availableFields: string[],
  rowFields: string[],
  colFields: string[],
  pageFields: PivotPageField[],
  dataFields: PivotDataFieldInput[],
): {
  rowFields: string[]
  colFields: string[]
  pageFields: PivotPageField[]
  dataFields: PivotValueField[]
} {
  const canonical = new Map(availableFields.map((f) => [f.toLowerCase(), f]))
  const resolveField = (name: string): string => {
    const hit = canonical.get(name.trim().toLowerCase())
    if (!hit)
      throw new XlsxError(
        `Unknown pivot field “${name}” (available: ${availableFields.join(', ')}).`,
      )
    return hit
  }
  const dedupList = (list: string[]) => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of list) {
      const f = resolveField(raw)
      if (!seen.has(f.toLowerCase())) {
        seen.add(f.toLowerCase())
        out.push(f)
      }
    }
    return out
  }
  const rows = dedupList(rowFields)
  const cols = dedupList(colFields)
  const pages: PivotPageField[] = []
  const seenPage = new Set<string>()
  for (const pf of pageFields) {
    const f = resolveField(pf.field)
    if (seenPage.has(f.toLowerCase())) continue
    seenPage.add(f.toLowerCase())
    pages.push(pf.selectedItem !== undefined ? { field: f, selectedItem: pf.selectedItem } : { field: f })
  }
  const usedDfNames = new Set<string>()
  const values: PivotValueField[] = dataFields.map((df) => {
    const f = resolveField(df.field)
    const agg: PivotAgg = df.agg ?? 'sum'
    if (!isPivotAgg(agg)) throw new XlsxError(`Unsupported pivot aggregation “${String(agg)}”.`)
    const baseName = df.name?.trim() || defaultDataFieldName(f, agg)
    let name = baseName
    let n = 2
    while (usedDfNames.has(name.toLowerCase())) name = `${baseName} ${n++}`
    usedDfNames.add(name.toLowerCase())
    return { field: f, agg, name, ...(df.numFmt ? { numFmt: df.numFmt } : {}) }
  })
  return { rowFields: rows, colFields: cols, pageFields: pages, dataFields: values }
}

function checkPivotTargetClear(
  wb: Workbook,
  targetInfo: SheetInfo,
  range: Range,
  ignorePivotPart?: string,
) {
  const d = wb.sheet(targetInfo.name)
  const merge = d.merges.find((m) => rangesOverlap(m, range))
  if (merge)
    throw new XlsxError(
      `Pivot target ${rangeName(range)} overlaps merged cells ${rangeName(merge)}.`,
    )
  const table = readSheetTables(wb, targetInfo.name).find((t) => rangesOverlap(t.ref, range))
  if (table)
    throw new XlsxError(
      `Pivot target ${rangeName(range)} overlaps table “${table.displayName}” (${rangeName(table.ref)}).`,
    )
  const otherPivot = readSheetPivots(wb, targetInfo.name).find(
    (p) => (!ignorePivotPart || p.part !== ignorePivotPart) && rangesOverlap(p.location, range),
  )
  if (otherPivot)
    throw new XlsxError(
      `Pivot target ${rangeName(range)} overlaps pivot table “${otherPivot.name}” (${rangeName(otherPivot.location)}).`,
    )
}

function writePivotGridCells(
  wb: Workbook,
  targetInfo: SheetInfo,
  sheetDoc: XMLDocument,
  oldLocation: Range | null,
  topLeft: { row: number; col: number },
  calc: PivotCalcResult,
) {
  if (oldLocation) {
    for (let r = oldLocation.top; r <= oldLocation.bottom; r++) {
      for (let c = oldLocation.left; c <= oldLocation.right; c++) {
        writeCell(wb, sheetDoc, r, c, { kind: 'clear' }, 0)
      }
    }
  }
  const hasFmt = calc.cells.some((c) => c.numFmt)
  let sdoc: XMLDocument | null = null
  const fmtCache = new Map<string, number>()
  const data = wb.sheet(targetInfo.name)
  for (const c of calc.cells) {
    const r = topLeft.row + c.row
    const col = topLeft.col + c.col
    let style: number | undefined
    if (c.numFmt && hasFmt) {
      let sIdx = fmtCache.get(c.numFmt)
      if (sIdx === undefined) {
        let stylesPart = wb.stylesPart()
        if (!stylesPart) {
          stylesPart = '/xl/styles.xml'
          wb.write(
            stylesPart,
            strToU8(
              `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS_MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
            ),
            'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
          )
          wb.touch(relsPartOf(wb.part))
          wb.pkg.addRelationship(wb.part, `${REL}styles`, relativeTarget(wb.part, stylesPart))
        }
        sdoc ??= wb.edit(stylesPart)
        const baseStyle = data.cells.get(cellKey(r, col))?.style ?? 0
        sIdx = xfWithNumFmt(sdoc, baseStyle, c.numFmt)
        fmtCache.set(c.numFmt, sIdx)
      }
      style = sIdx
    }
    if (c.value === null) writeCell(wb, sheetDoc, r, col, { kind: 'clear' }, style)
    else writeCell(wb, sheetDoc, r, col, { kind: 'value', value: c.value }, style)
  }
}

function checkPivotName(wb: Workbook, nameRaw: string, ignorePart?: string): string {
  const n = nameRaw.trim()
  if (!n) throw new XlsxError('Pivot table name cannot be empty.')
  if (n.length > 255) throw new XlsxError(`Pivot table name “${n}” is longer than 255 characters.`)
  const key = n.toLowerCase()
  for (const p of readWorkbookPivots(wb)) {
    if (ignorePart && p.part === ignorePart) continue
    if (p.name.toLowerCase() === key)
      throw new XlsxError(`There is already a pivot table named “${p.name}”.`)
  }
  return n
}

function nextDefaultPivotName(wb: Workbook): string {
  const used = new Set(readWorkbookPivots(wb).map((p) => p.name.toLowerCase()))
  for (let i = 1; ; i++) {
    const candidate = `PivotTable${i}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

// ---------------------------------------------------------------------------
// Create, Refresh, Update, Delete

export function createPivot(
  wb: Workbook,
  op: CreatePivotOp,
  addSheetFn: (name: string) => SheetInfo,
): { sheets: string[]; pivot: string; focus?: string } {
  const src = resolvePivotSource(wb, op.sourceSheet, op.source)
  const cfg = validatePivotFieldConfig(
    src.fields,
    op.rowFields ?? [],
    op.colFields ?? [],
    op.pageFields ?? [],
    op.dataFields ?? [],
  )
  const pivotName = op.name !== undefined ? checkPivotName(wb, op.name) : nextDefaultPivotName(wb)

  let targetInfo: SheetInfo
  let focusSheet: string | undefined
  if (op.targetSheet) {
    targetInfo = wb.requireWorksheet(op.targetSheet)
  } else {
    const usedSheets = new Set(wb.sheets().map((s) => s.name.toLowerCase()))
    let sn = 1
    while (usedSheets.has(`pivottable${sn}`) || usedSheets.has(`pivot${sn}`)) sn++
    targetInfo = addSheetFn(`PivotTable${sn}`)
    focusSheet = targetInfo.name
  }

  const targetAddr = requireCell(op.targetCell ?? (op.targetSheet ? 'A1' : 'A3'))
  const rowGrandTotals = op.rowGrandTotals ?? true
  const colGrandTotals = op.colGrandTotals ?? true
  const subtotals = op.subtotals ?? true
  const styleName = op.style ?? 'PivotStyleLight16'

  const calcResult = computePivot({
    fields: src.fields,
    records: src.records,
    ...cfg,
    rowGrandTotals,
    colGrandTotals,
    subtotals,
  })
  const location: Range = {
    top: targetAddr.row,
    left: targetAddr.col,
    bottom: targetAddr.row + calcResult.rows - 1,
    right: targetAddr.col + calcResult.cols - 1,
  }
  checkPivotTargetClear(wb, targetInfo, location)

  // Allocate cacheId & cache files
  const wbRoot = wb.edit(wb.part).documentElement!
  let cachesEl = kid(wbRoot, 'pivotCaches')
  const existingIds = cachesEl
    ? kids(cachesEl, 'pivotCache').map((c) => Number(c.getAttribute('cacheId') ?? 0))
    : []
  const cacheId = Math.max(0, ...existingIds) + 1
  let cNum = cacheId
  while (
    wb.pkg.has(`/xl/pivotCache/pivotCacheDefinition${cNum}.xml`) ||
    wb.pkg.has(`/xl/pivotCache/pivotCacheRecords${cNum}.xml`)
  )
    cNum++
  const cacheDefPart = `/xl/pivotCache/pivotCacheDefinition${cNum}.xml`
  const cacheRecPart = `/xl/pivotCache/pivotCacheRecords${cNum}.xml`
  writeCacheXml(wb, cacheDefPart, cacheRecPart, src)

  wb.touch(relsPartOf(wb.part))
  const wbCacheRelId = wb.pkg.addRelationship(
    wb.part,
    REL_PIVOT_CACHE_DEF,
    relativeTarget(wb.part, cacheDefPart),
  )
  if (!cachesEl) {
    cachesEl = make(wbRoot.ownerDocument!, 'pivotCaches')
    insertInOrder(wbRoot, cachesEl, WORKBOOK_ORDER)
  }
  const pcEl = make(wbRoot.ownerDocument!, 'pivotCache')
  pcEl.setAttribute('cacheId', String(cacheId))
  if (!wbRoot.lookupPrefix(NS_R)) wbRoot.setAttribute('xmlns:r', NS_R)
  const rPref = wbRoot.lookupPrefix(NS_R) ?? 'r'
  pcEl.setAttributeNS(NS_R, `${rPref}:id`, wbCacheRelId)
  cachesEl.appendChild(pcEl)

  let ptNum = 1
  while (wb.pkg.has(`/xl/pivotTables/pivotTable${ptNum}.xml`)) ptNum++
  const ptPart = `/xl/pivotTables/pivotTable${ptNum}.xml`
  writePivotTableXml(wb, ptPart, {
    name: pivotName,
    cacheId,
    location,
    calc: calcResult,
    fields: src.fields,
    sharedItems: src.sharedItems,
    ...cfg,
    hiddenItems: {},
    rowGrandTotals,
    colGrandTotals,
    subtotals,
    styleName,
  })
  wb.touch(relsPartOf(ptPart))
  wb.pkg.addRelationship(ptPart, REL_PIVOT_CACHE_DEF, relativeTarget(ptPart, cacheDefPart))

  wb.touch(relsPartOf(targetInfo.part))
  wb.pkg.addRelationship(targetInfo.part, REL_PIVOT_TABLE, relativeTarget(targetInfo.part, ptPart))

  const sheetDoc = wb.edit(targetInfo.part)
  normalizeRefs(sheetDoc)
  writePivotGridCells(wb, targetInfo, sheetDoc, null, targetAddr, calcResult)
  wb.forgetSheet(targetInfo.part)

  return {
    sheets: [targetInfo.name],
    pivot: pivotName,
    ...(focusSheet ? { focus: focusSheet } : {}),
  }
}

/**
 * What a PivotTable has that this editor doesn't model: rewriting its
 * definition (Refresh, a field change) would drop it, so those are refused
 * and the PivotTable is left exactly as Excel wrote it.
 */
export function unmodeledPivotFeatures(wb: Workbook, p: PivotTableInfo): string[] {
  const out = new Set<string>()
  const root = wb.pkg.xml(p.part).documentElement!
  const has = (el: Element, name: string) => kids(el, name).length > 0
  if (has(root, 'calculatedItems') || all(wb.pkg.xml(p.part), 'calculatedItem').length > 0)
    out.add('calculated items')
  if (has(root, 'filters')) out.add('label or value filters')
  if (has(root, 'formats') || has(root, 'conditionalFormats')) out.add('PivotTable formatting')
  if (has(root, 'chartFormats')) out.add('a PivotChart')
  if (has(root, 'pivotHierarchies') || has(root, 'rowHierarchiesUsage')) out.add('an OLAP source')
  if (has(root, 'extLst')) out.add('newer PivotTable features (extensions)')
  if (root.getAttribute('compact') === '0' || root.getAttribute('outline') === '0')
    out.add('outline or tabular form')
  const df = kid(root, 'dataFields')
  for (const d of df ? kids(df, 'dataField') : [])
    if ((d.getAttribute('showDataAs') ?? 'normal') !== 'normal') out.add('“show values as”')
  const cache = wb.pkg.xml(p.cacheDefPart).documentElement!
  const source = kid(cache, 'cacheSource')
  if ((source?.getAttribute('type') ?? 'worksheet') !== 'worksheet') out.add('an external source')
  const cf = kid(cache, 'cacheFields')
  for (const f of cf ? kids(cf, 'cacheField') : []) {
    if (f.hasAttribute('formula')) out.add('calculated fields')
    if (has(f, 'fieldGroup')) out.add('grouped items (dates or number ranges)')
  }
  if (has(cache, 'calculatedItems')) out.add('calculated items')
  if (has(cache, 'cacheHierarchies')) out.add('an OLAP source')
  return [...out]
}

function refuseUnmodeled(wb: Workbook, p: PivotTableInfo, what: string) {
  const features = unmodeledPivotFeatures(wb, p)
  if (features.length > 0)
    throw new XlsxError(
      `The PivotTable “${p.name}” uses ${features.join(', ')}, which this editor doesn't ${what} without losing; ${what} it in Excel.`,
    )
}

export function refreshPivot(wb: Workbook, op: RefreshPivotOp): { sheets: string[]; pivot: string } {
  const targetInfo = wb.requireWorksheet(op.sheet)
  const existing = findPivot(wb, targetInfo.name, op.pivot)
  refuseUnmodeled(wb, existing, 'refresh')
  const src = resolvePivotSource(wb, existing.sourceSheet, existing.sourceRef, existing.sourceTable)
  const cfg = validatePivotFieldConfig(
    src.fields,
    existing.rowFields.filter((f) => src.fields.some((sf) => sf.toLowerCase() === f.toLowerCase())),
    existing.colFields.filter((f) => src.fields.some((sf) => sf.toLowerCase() === f.toLowerCase())),
    existing.pageFields.filter((p) =>
      src.fields.some((sf) => sf.toLowerCase() === p.field.toLowerCase()),
    ),
    existing.dataFields.filter((d) =>
      src.fields.some((sf) => sf.toLowerCase() === d.field.toLowerCase()),
    ),
  )
  const calcResult = computePivot({
    fields: src.fields,
    records: src.records,
    ...cfg,
    hiddenItems: existing.hiddenItems,
    rowGrandTotals: existing.rowGrandTotals,
    colGrandTotals: existing.colGrandTotals,
    subtotals: existing.subtotals,
  })
  const topLeft = { row: existing.location.top, col: existing.location.left }
  const nextLoc: Range = {
    top: topLeft.row,
    left: topLeft.col,
    bottom: topLeft.row + calcResult.rows - 1,
    right: topLeft.col + calcResult.cols - 1,
  }
  checkPivotTargetClear(wb, targetInfo, nextLoc, existing.part)

  const recPart =
    existing.cacheRecordsPart ??
    existing.cacheDefPart.replace(/pivotCacheDefinition(\d*)\.xml$/i, 'pivotCacheRecords$1.xml')
  writeCacheXml(wb, existing.cacheDefPart, recPart, src)
  writePivotTableXml(wb, existing.part, {
    name: existing.name,
    cacheId: existing.cacheId,
    location: nextLoc,
    calc: calcResult,
    fields: src.fields,
    sharedItems: src.sharedItems,
    ...cfg,
    hiddenItems: existing.hiddenItems,
    rowGrandTotals: existing.rowGrandTotals,
    colGrandTotals: existing.colGrandTotals,
    subtotals: existing.subtotals,
    styleName: existing.styleName,
  })

  const sheetDoc = wb.edit(targetInfo.part)
  normalizeRefs(sheetDoc)
  writePivotGridCells(wb, targetInfo, sheetDoc, existing.location, topLeft, calcResult)
  wb.forgetSheet(targetInfo.part)

  return { sheets: [targetInfo.name], pivot: existing.name }
}

export function updatePivot(wb: Workbook, op: UpdatePivotOp): { sheets: string[]; pivot: string } {
  const targetInfo = wb.requireWorksheet(op.sheet)
  const existing = findPivot(wb, targetInfo.name, op.pivot)
  refuseUnmodeled(wb, existing, 'change')
  const nextName =
    op.name !== undefined && op.name.trim().toLowerCase() !== existing.name.toLowerCase()
      ? checkPivotName(wb, op.name, existing.part)
      : existing.name

  const src = resolvePivotSource(wb, existing.sourceSheet, existing.sourceRef, existing.sourceTable)
  const cfg = validatePivotFieldConfig(
    src.fields,
    op.rowFields ?? existing.rowFields,
    op.colFields ?? existing.colFields,
    op.pageFields ?? existing.pageFields,
    op.dataFields ?? existing.dataFields,
  )
  const hiddenItems = op.hiddenItems ?? existing.hiddenItems
  const rowGrandTotals = op.rowGrandTotals ?? existing.rowGrandTotals
  const colGrandTotals = op.colGrandTotals ?? existing.colGrandTotals
  const subtotals = op.subtotals ?? existing.subtotals
  const styleName = op.style ?? existing.styleName

  const calcResult = computePivot({
    fields: src.fields,
    records: src.records,
    ...cfg,
    hiddenItems,
    rowGrandTotals,
    colGrandTotals,
    subtotals,
  })
  const topLeft = { row: existing.location.top, col: existing.location.left }
  const nextLoc: Range = {
    top: topLeft.row,
    left: topLeft.col,
    bottom: topLeft.row + calcResult.rows - 1,
    right: topLeft.col + calcResult.cols - 1,
  }
  checkPivotTargetClear(wb, targetInfo, nextLoc, existing.part)

  const recPart =
    existing.cacheRecordsPart ??
    existing.cacheDefPart.replace(/pivotCacheDefinition(\d*)\.xml$/i, 'pivotCacheRecords$1.xml')
  writeCacheXml(wb, existing.cacheDefPart, recPart, src)
  writePivotTableXml(wb, existing.part, {
    name: nextName,
    cacheId: existing.cacheId,
    location: nextLoc,
    calc: calcResult,
    fields: src.fields,
    sharedItems: src.sharedItems,
    ...cfg,
    hiddenItems,
    rowGrandTotals,
    colGrandTotals,
    subtotals,
    styleName,
  })

  const sheetDoc = wb.edit(targetInfo.part)
  normalizeRefs(sheetDoc)
  writePivotGridCells(wb, targetInfo, sheetDoc, existing.location, topLeft, calcResult)
  wb.forgetSheet(targetInfo.part)

  return { sheets: [targetInfo.name], pivot: nextName }
}

export function deletePivot(wb: Workbook, op: DeletePivotOp): { sheets: string[] } {
  const info = wb.requireWorksheet(op.sheet)
  const existing = findPivot(wb, info.name, op.pivot)
  if (!op.keepValues) {
    const sheetDoc = wb.edit(info.part)
    normalizeRefs(sheetDoc)
    for (let r = existing.location.top; r <= existing.location.bottom; r++) {
      for (let c = existing.location.left; c <= existing.location.right; c++) {
        writeCell(wb, sheetDoc, r, c, { kind: 'clear' }, 0)
      }
    }
  }

  const sheetRelsPath = relsPartOf(info.part)
  if (wb.pkg.has(sheetRelsPath)) {
    const relsDoc = wb.edit(sheetRelsPath)
    for (const r of kids(
      relsDoc.documentElement!,
      'Relationship',
      'http://schemas.openxmlformats.org/package/2006/relationships',
    )) {
      if (r.getAttribute('Id') === existing.relId) relsDoc.documentElement!.removeChild(r)
    }
  }
  wb.remove(existing.part)
  wb.remove(relsPartOf(existing.part))

  // Orphan cache cleanup if no remaining pivot references this cacheDefPart
  const remaining = readWorkbookPivots(wb)
  const stillUsed = remaining.some((p) => p.cacheDefPart === existing.cacheDefPart)
  if (!stillUsed) {
    const wbDoc = wb.edit(wb.part)
    const wbRoot = wbDoc.documentElement!
    const cachesEl = kid(wbRoot, 'pivotCaches')
    const removedRelIds = new Set<string>()
    if (cachesEl) {
      for (const pc of kids(cachesEl, 'pivotCache')) {
        if (Number(pc.getAttribute('cacheId') ?? -1) === existing.cacheId) {
          const rid = pc.getAttributeNS(NS_R, 'id') ?? pc.getAttribute('r:id')
          if (rid) removedRelIds.add(rid)
          cachesEl.removeChild(pc)
        }
      }
      if (kids(cachesEl, 'pivotCache').length === 0) wbRoot.removeChild(cachesEl)
    }
    const wbRelsPath = relsPartOf(wb.part)
    if (wb.pkg.has(wbRelsPath)) {
      const wbRels = wb.edit(wbRelsPath)
      for (const r of kids(
        wbRels.documentElement!,
        'Relationship',
        'http://schemas.openxmlformats.org/package/2006/relationships',
      )) {
        if (
          removedRelIds.has(r.getAttribute('Id') ?? '') ||
          r.getAttribute('Target') === relativeTarget(wb.part, existing.cacheDefPart)
        ) {
          wbRels.documentElement!.removeChild(r)
        }
      }
    }
    wb.remove(existing.cacheDefPart)
    wb.remove(relsPartOf(existing.cacheDefPart))
    if (existing.cacheRecordsPart) wb.remove(existing.cacheRecordsPart)
  }

  wb.forgetSheet(info.part)
  return { sheets: [info.name] }
}

// ---------------------------------------------------------------------------
// GETPIVOTDATA evaluation

/**
 * GETPIVOTDATA reads what the PivotTable shows: its values as last refreshed,
 * i.e. its cache records (not the source cells, which may have changed since —
 * Excel's answer changes only on Refresh). A PivotTable saved without its
 * records ("Save source data with file" off) can't be answered from the file.
 */
export function evaluateGetPivotData(
  wb: Workbook,
  pivotSheet: string,
  row: number,
  col: number,
  dataField: string,
  pairs: Array<[string, CellValue]>,
): CellValue {
  const pivot = pivotAtCell(wb, pivotSheet, row, col)
  if (!pivot) return { error: '#REF!' }
  const cache = readCache(wb, pivot.cacheDefPart)
  if (!cache.recordsPart)
    throw new Unsupported('GETPIVOTDATA of a PivotTable saved without its source data')
  const fields = cache.fields
  const records = cache.records

  const calcResult = computePivot({
    fields,
    records,
    rowFields: pivot.rowFields,
    colFields: pivot.colFields,
    pageFields: pivot.pageFields,
    dataFields: pivot.dataFields,
    hiddenItems: pivot.hiddenItems,
    rowGrandTotals: pivot.rowGrandTotals,
    colGrandTotals: pivot.colGrandTotals,
    subtotals: pivot.subtotals,
  })
  return calcResult.lookup(dataField, pairs)
}
