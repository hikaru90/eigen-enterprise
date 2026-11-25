import { isErrorValue, type CellValue } from './workbook'

/**
 * Pure PivotTable calculation engine (rows, columns, page filters, values,
 * item filters, multi-level subtotals, grand totals, and GETPIVOTDATA lookup).
 */

export type PivotAgg =
  | 'sum'
  | 'count'
  | 'average'
  | 'min'
  | 'max'
  | 'product'
  | 'countNums'
  | 'stdDev'
  | 'var'

export type PivotValueField = {
  field: string
  name: string
  agg: PivotAgg
  numFmt?: string
}

export type PivotPageField = {
  field: string
  selectedItem?: string
}

export type PivotCalcInput = {
  fields: string[]
  records: Array<Record<string, CellValue>>
  rowFields: string[]
  colFields: string[]
  pageFields: PivotPageField[]
  dataFields: PivotValueField[]
  hiddenItems?: Record<string, string[]>
  rowGrandTotals?: boolean
  colGrandTotals?: boolean
  subtotals?: boolean
}

export type PivotCellRole =
  | 'blank'
  | 'pageLabel'
  | 'pageValue'
  | 'colHeader'
  | 'colTotal'
  | 'rowHeader'
  | 'rowLabel'
  | 'value'
  | 'subtotal'
  | 'grandTotal'

export type PivotGridCell = {
  row: number
  col: number
  value: CellValue
  role: PivotCellRole
  numFmt?: string
}

export type PivotTupleMeta = {
  type: 'data' | 'subtotal' | 'grand'
  /** Shared/unique item keys along the axis path (for XML rowItems/colItems). */
  keys: string[]
  dataFieldIndex?: number
}

export type PivotCalcResult = {
  rows: number
  cols: number
  firstHeaderRow: number
  firstDataRow: number
  firstDataCol: number
  cells: PivotGridCell[]
  /** Full matrix `[row][col]` for fast lookup. */
  matrix: CellValue[][]
  rowTuples: PivotTupleMeta[]
  colTuples: PivotTupleMeta[]
  /** Distinct item keys seen per field across all source records (sorted). */
  fieldItems: Record<string, string[]>
  /** Distinct values filtered to what appears cleanly in the pivot. */
  lookup: (dataField: string, pairs: Array<[string, CellValue]>) => CellValue
}

const VALID_AGGS = new Set<PivotAgg>([
  'sum',
  'count',
  'average',
  'min',
  'max',
  'product',
  'countNums',
  'stdDev',
  'var',
])

export function isPivotAgg(s: string): s is PivotAgg {
  return VALID_AGGS.has(s as PivotAgg)
}

export function defaultDataFieldName(field: string, agg: PivotAgg): string {
  switch (agg) {
    case 'sum':
      return `Sum of ${field}`
    case 'count':
      return `Count of ${field}`
    case 'average':
      return `Average of ${field}`
    case 'min':
      return `Min of ${field}`
    case 'max':
      return `Max of ${field}`
    case 'product':
      return `Product of ${field}`
    case 'countNums':
      return `Count of ${field}`
    case 'stdDev':
      return `StdDev of ${field}`
    case 'var':
      return `Var of ${field}`
  }
}

export function itemKey(v: CellValue): string {
  if (v === null || v === '') return '(blank)'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (isErrorValue(v)) return v.error
  return String(v)
}

const collator = new Intl.Collator('en', { sensitivity: 'accent' })

export function compareItemKeys(a: string, b: string): number {
  if (a === b) return 0
  if (a === '(blank)') return 1
  if (b === '(blank)') return -1
  const na = Number(a)
  const nb = Number(b)
  const aNum = a !== '' && Number.isFinite(na)
  const bNum = b !== '' && Number.isFinite(nb)
  if (aNum && bNum) return na - nb
  if (aNum !== bNum) return aNum ? -1 : 1
  return collator.compare(a, b)
}

export function aggregateField(values: CellValue[], agg: PivotAgg): CellValue {
  if (agg === 'count') {
    let n = 0
    for (const v of values) if (v !== null && v !== '') n++
    return n === 0 ? null : n
  }
  const nums: number[] = []
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) nums.push(v)
  if (agg === 'countNums') return nums.length === 0 ? null : nums.length
  if (nums.length === 0) return null
  switch (agg) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0)
    case 'average':
      return nums.reduce((a, b) => a + b, 0) / nums.length
    case 'min':
      return Math.min(...nums)
    case 'max':
      return Math.max(...nums)
    case 'product':
      return nums.reduce((a, b) => a * b, 1)
    case 'stdDev': {
      if (nums.length < 2) return { error: '#DIV/0!' }
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length
      const ss = nums.reduce((a, b) => a + (b - mean) ** 2, 0)
      return Math.sqrt(ss / (nums.length - 1))
    }
    case 'var': {
      if (nums.length < 2) return { error: '#DIV/0!' }
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length
      const ss = nums.reduce((a, b) => a + (b - mean) ** 2, 0)
      return ss / (nums.length - 1)
    }
  }
}

const SEP = '\u0000'
const joinKey = (parts: string[]) => parts.join(SEP)

function buildTuples(
  keysList: string[][],
  includeSubtotals: boolean,
  includeGrand: boolean,
  grandLabel: string,
): PivotTupleMeta[] {
  const levelCount = keysList[0]?.length ?? 0
  if (levelCount === 0) {
    return [{ type: 'grand', keys: [grandLabel] }]
  }
  const uniqueMap = new Map<string, string[]>()
  for (const k of keysList) uniqueMap.set(joinKey(k), k)
  const sorted = [...uniqueMap.values()].sort((a, b) => {
    for (let i = 0; i < levelCount; i++) {
      const c = compareItemKeys(a[i]!, b[i]!)
      if (c !== 0) return c
    }
    return 0
  })

  const out: PivotTupleMeta[] = []
  if (!includeSubtotals || levelCount === 1) {
    for (const k of sorted) out.push({ type: 'data', keys: k })
  } else {
    const emit = (items: string[][], depth: number, prefix: string[]) => {
      if (depth === levelCount) {
        out.push({ type: 'data', keys: prefix })
        return
      }
      const groups = new Map<string, string[][]>()
      for (const item of items) {
        const key = item[depth]!
        let arr = groups.get(key)
        if (!arr) {
          arr = []
          groups.set(key, arr)
        }
        arr.push(item)
      }
      for (const [k, subItems] of groups) {
        const nextPrefix = [...prefix, k]
        emit(subItems, depth + 1, nextPrefix)
        if (depth < levelCount - 1) {
          const subKeys = [...nextPrefix]
          while (subKeys.length < levelCount) subKeys.push('')
          subKeys[depth] = `${k} Total`
          out.push({ type: 'subtotal', keys: nextPrefix })
        }
      }
    }
    emit(sorted, 0, [])
  }
  if (includeGrand) out.push({ type: 'grand', keys: [grandLabel] })
  return out
}

export function computePivot(input: PivotCalcInput): PivotCalcResult {
  const rowFields = input.rowFields
  const colFields = input.colFields
  const pageFields = input.pageFields
  const dataFields = input.dataFields
  const rowGrandTotals = input.rowGrandTotals !== false
  const colGrandTotals = input.colGrandTotals !== false
  const subtotals = input.subtotals !== false
  const hidden = new Map<string, Set<string>>()
  if (input.hiddenItems) {
    for (const [f, items] of Object.entries(input.hiddenItems)) {
      hidden.set(f.toLowerCase(), new Set(items.map((x) => x.toLowerCase())))
    }
  }

  // Distinct items per field across all source records
  const fieldItems: Record<string, string[]> = {}
  for (const f of input.fields) {
    const seen = new Set<string>()
    for (const r of input.records) seen.add(itemKey(r[f] ?? null))
    fieldItems[f] = [...seen].sort(compareItemKeys)
  }

  const isItemHidden = (field: string, key: string) =>
    hidden.get(field.toLowerCase())?.has(key.toLowerCase()) ?? false

  // Filter source records by page filters and row/column item filters
  const filtered = input.records.filter((rec) => {
    for (const pf of pageFields) {
      const k = itemKey(rec[pf.field] ?? null)
      if (isItemHidden(pf.field, k)) return false
      if (
        pf.selectedItem !== undefined &&
        pf.selectedItem !== '' &&
        pf.selectedItem !== '(All)' &&
        k.toLowerCase() !== pf.selectedItem.toLowerCase()
      )
        return false
    }
    for (const rf of rowFields) {
      if (isItemHidden(rf, itemKey(rec[rf] ?? null))) return false
    }
    for (const cf of colFields) {
      if (isItemHidden(cf, itemKey(rec[cf] ?? null))) return false
    }
    return true
  })

  const rowKeySets = filtered.map((rec) => rowFields.map((f) => itemKey(rec[f] ?? null)))
  const colKeySets = filtered.map((rec) => colFields.map((f) => itemKey(rec[f] ?? null)))

  const rowTuples = buildTuples(
    rowKeySets,
    subtotals && rowFields.length >= 2,
    colGrandTotals,
    'Grand Total',
  )
  const baseColTuples = buildTuples(
    colKeySets,
    subtotals && colFields.length >= 2,
    rowGrandTotals,
    'Grand Total',
  )

  const colTuples: PivotTupleMeta[] = []
  if (dataFields.length <= 1) {
    for (const ct of baseColTuples) colTuples.push({ ...ct, dataFieldIndex: 0 })
  } else {
    for (const ct of baseColTuples) {
      for (let dfIdx = 0; dfIdx < dataFields.length; dfIdx++) {
        colTuples.push({ ...ct, dataFieldIndex: dfIdx })
      }
    }
  }

  // Layout geometry relative to pivot top-left (0, 0)
  const pageRowOffset = pageFields.length > 0 ? pageFields.length + 1 : 0
  const colHeaderRows =
    colFields.length + (dataFields.length > 1 || colFields.length === 0 ? 1 : 0)
  const effectiveColHeaderRows = Math.max(1, colHeaderRows)
  const rowLabelCols = Math.max(1, rowFields.length)
  const dataCols = Math.max(1, dataFields.length === 0 ? 1 : colTuples.length)
  const dataRows = Math.max(1, rowTuples.length)

  const firstHeaderRow = pageRowOffset
  const firstDataRow = pageRowOffset + effectiveColHeaderRows
  const firstDataCol = rowFields.length > 0 ? rowLabelCols : 1
  const totalRows = firstDataRow + dataRows
  const totalCols = Math.max(
    firstDataCol + (dataFields.length === 0 && colFields.length === 0 ? 0 : dataCols),
    pageFields.length > 0 ? 2 : 1,
  )

  const cells: PivotGridCell[] = []
  const matrix: CellValue[][] = Array.from({ length: totalRows }, () =>
    Array.from({ length: Math.max(2, totalCols) }, () => null),
  )

  const setCell = (
    r: number,
    c: number,
    value: CellValue,
    role: PivotCellRole,
    numFmt?: string,
  ) => {
    while (matrix.length <= r) matrix.push([])
    while (matrix[r]!.length <= c) matrix[r]!.push(null)
    matrix[r]![c] = value
    cells.push({ row: r, col: c, value, role, ...(numFmt ? { numFmt } : {}) })
  }

  // 1. Page (Report Filter) rows
  for (let i = 0; i < pageFields.length; i++) {
    const pf = pageFields[i]!
    setCell(i, 0, pf.field, 'pageLabel')
    setCell(i, 1, pf.selectedItem && pf.selectedItem !== '' ? pf.selectedItem : '(All)', 'pageValue')
  }

  // 2. Column headers
  const headerBottomRow = firstDataRow - 1
  if (rowFields.length > 0) {
    for (let c = 0; c < rowFields.length; c++) {
      setCell(headerBottomRow, c, rowFields[c]!, 'rowHeader')
    }
  } else {
    setCell(headerBottomRow, 0, dataFields.length > 0 ? 'Values' : 'Row Labels', 'rowHeader')
  }

  const measureHeaderRow = colFields.length > 0 && dataFields.length > 1 ? headerBottomRow : -1
  for (let ci = 0; ci < colTuples.length; ci++) {
    const colIdx = firstDataCol + ci
    const ct = colTuples[ci]!
    if (dataFields.length === 0 && colFields.length === 0) break
    if (colFields.length === 0) {
      const df = dataFields[ct.dataFieldIndex ?? 0]
      setCell(headerBottomRow, colIdx, df?.name ?? 'Values', 'colHeader')
      continue
    }
    const prev = ci > 0 ? colTuples[ci - 1] : null
    if (ct.type === 'grand') {
      const label = dataFields.length > 1 ? 'Grand Total' : 'Grand Total'
      if (!prev || prev.type !== 'grand') setCell(firstHeaderRow, colIdx, label, 'colTotal')
      if (measureHeaderRow >= 0) {
        setCell(measureHeaderRow, colIdx, dataFields[ct.dataFieldIndex ?? 0]!.name, 'colTotal')
      }
      continue
    }
    for (let lvl = 0; lvl < colFields.length; lvl++) {
      const r = firstHeaderRow + lvl
      const val = ct.type === 'subtotal' && lvl === ct.keys.length - 1 ? `${ct.keys[lvl]} Total` : (ct.keys[lvl] ?? '')
      if (lvl < ct.keys.length) {
        const sameAsPrev =
          prev &&
          prev.type === ct.type &&
          prev.keys.slice(0, lvl + 1).join(SEP) === ct.keys.slice(0, lvl + 1).join(SEP)
        if (!sameAsPrev) setCell(r, colIdx, val, ct.type === 'subtotal' ? 'subtotal' : 'colHeader')
      }
    }
    if (measureHeaderRow >= 0) {
      setCell(
        measureHeaderRow,
        colIdx,
        dataFields[ct.dataFieldIndex ?? 0]!.name,
        ct.type === 'subtotal' ? 'subtotal' : 'colHeader',
      )
    }
  }

  // Pre-bucket records for fast aggregation
  const matchesTuple = (recKeys: string[], tuple: PivotTupleMeta): boolean => {
    if (tuple.type === 'grand') return true
    for (let i = 0; i < tuple.keys.length; i++) {
      if (recKeys[i] !== tuple.keys[i]) return false
    }
    return true
  }

  const computeAggFor = (rt: PivotTupleMeta, ct: PivotTupleMeta, df: PivotValueField): CellValue => {
    const vals: CellValue[] = []
    for (let i = 0; i < filtered.length; i++) {
      if (!matchesTuple(rowKeySets[i]!, rt)) continue
      if (!matchesTuple(colKeySets[i]!, ct)) continue
      vals.push(filtered[i]![df.field] ?? null)
    }
    return aggregateField(vals, df.agg)
  }

  // 3. Row headers & values
  for (let ri = 0; ri < rowTuples.length; ri++) {
    const r = firstDataRow + ri
    const rt = rowTuples[ri]!
    const prev = ri > 0 ? rowTuples[ri - 1] : null

    if (rowFields.length === 0) {
      setCell(r, 0, dataFields.length > 1 ? 'Total' : (rt.type === 'grand' ? 'Grand Total' : 'Total'), rt.type === 'grand' ? 'grandTotal' : 'rowLabel')
    } else if (rt.type === 'grand') {
      setCell(r, 0, 'Grand Total', 'grandTotal')
    } else if (rt.type === 'subtotal') {
      const lvl = rt.keys.length - 1
      setCell(r, lvl, `${rt.keys[lvl]} Total`, 'subtotal')
    } else {
      for (let lvl = 0; lvl < rowFields.length; lvl++) {
        const sameAsPrev =
          prev &&
          prev.type === 'data' &&
          prev.keys.slice(0, lvl + 1).join(SEP) === rt.keys.slice(0, lvl + 1).join(SEP)
        if (!sameAsPrev || lvl === rowFields.length - 1) {
          setCell(r, lvl, rt.keys[lvl]!, 'rowLabel')
        }
      }
    }

    if (dataFields.length === 0) continue
    for (let ci = 0; ci < colTuples.length; ci++) {
      const ct = colTuples[ci]!
      const df = dataFields[ct.dataFieldIndex ?? 0]!
      const val = computeAggFor(rt, ct, df)
      const isGrand = rt.type === 'grand' || ct.type === 'grand'
      const isSub = !isGrand && (rt.type === 'subtotal' || ct.type === 'subtotal')
      const role: PivotCellRole = isGrand ? 'grandTotal' : isSub ? 'subtotal' : 'value'
      setCell(r, firstDataCol + ci, val, role, df.numFmt)
    }
  }

  // 4. GETPIVOTDATA lookup
  const lookup = (dataFieldArg: string, pairs: Array<[string, CellValue]>): CellValue => {
    if (dataFields.length === 0) return { error: '#REF!' }
    const dfQuery = dataFieldArg.trim().toLowerCase()
    const df =
      dataFields.find((d) => d.name.toLowerCase() === dfQuery) ??
      dataFields.find((d) => d.field.toLowerCase() === dfQuery)
    if (!df) return { error: '#REF!' }

    const constraints = new Map<string, string>()
    for (const [fRaw, vRaw] of pairs) {
      const fk = fRaw.trim().toLowerCase()
      const fieldName =
        rowFields.find((f) => f.toLowerCase() === fk) ??
        colFields.find((f) => f.toLowerCase() === fk) ??
        pageFields.find((p) => p.field.toLowerCase() === fk)?.field
      if (!fieldName) return { error: '#REF!' }
      const expected = itemKey(vRaw)
      if (isItemHidden(fieldName, expected)) return { error: '#REF!' }
      const existing = constraints.get(fieldName.toLowerCase())
      if (existing !== undefined && existing.toLowerCase() !== expected.toLowerCase())
        return { error: '#REF!' }
      constraints.set(fieldName.toLowerCase(), expected)
    }

    // Also honor page filters
    for (const pf of pageFields) {
      if (pf.selectedItem && pf.selectedItem !== '(All)') {
        const explicit = constraints.get(pf.field.toLowerCase())
        if (explicit !== undefined && explicit.toLowerCase() !== pf.selectedItem.toLowerCase())
          return { error: '#REF!' }
      }
    }

    // Filter matching records
    const matchedVals: CellValue[] = []
    for (const rec of filtered) {
      let ok = true
      for (const [fk, expected] of constraints) {
        const fieldName = input.fields.find((f) => f.toLowerCase() === fk) ?? fk
        if (itemKey(rec[fieldName] ?? null).toLowerCase() !== expected.toLowerCase()) {
          ok = false
          break
        }
      }
      if (ok) matchedVals.push(rec[df.field] ?? null)
    }
    if (matchedVals.length === 0) return { error: '#REF!' }
    return aggregateField(matchedVals, df.agg)
  }

  return {
    rows: totalRows,
    cols: Math.max(totalCols, 1),
    firstHeaderRow,
    firstDataRow,
    firstDataCol,
    cells,
    matrix,
    rowTuples,
    colTuples,
    fieldItems,
    lookup,
  }
}
