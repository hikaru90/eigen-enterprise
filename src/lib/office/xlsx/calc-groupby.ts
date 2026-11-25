import { sortOrder } from './calc-dynamic'
import { asMatrix, cols, err, isMatrix, rows, toNumber, truthy, Unsupported, type Matrix } from './calc-values'
import { isErrorValue, type CellValue, type ErrorValue } from './workbook'

/**
 * GROUPBY, PIVOTBY and PERCENTOF as Microsoft's function reference documents
 * them. Implemented: one or more row fields, values columns, a LAMBDA or an
 * eta-reduced function (one argument, or two — the subset and the set it is
 * relative to — as PERCENTOF), field headers 0/1/3 and the documented
 * automatic rule (text then a number = headers), grand totals at the bottom
 * or top, sort orders, filter arrays, field relationship; PIVOTBY with one
 * row field, one column field, one values column and relative_to 0–2.
 *
 * Refused (`Unsupported`), because the reference doesn't say what Excel
 * shows: subtotal rows (their labels and placement), generated headers
 * (field_headers 2), PIVOTBY with several fields or values or shown
 * headers, relative_to 3/4, blank or error keys, keys that differ only in
 * case, sorting multi-level rows by a value, a vector of functions. Empty
 * places in the result (beside "Total", the corner, a PIVOTBY cell with no
 * data) are empty text.
 */

export type Aggregator = {
  /** 1: the group's values; 2: the group's values and the values it is relative to. */
  arity: number
  run(subset: Matrix, total: Matrix): CellValue
}

type GArg = CellValue | Matrix | undefined

class Fail {
  constructor(readonly error: ErrorValue) {}
}
const fail = (code: string): never => {
  throw new Fail(err(code))
}
function guard(f: () => CellValue | Matrix): CellValue | Matrix {
  try {
    return f()
  } catch (e) {
    if (e instanceof Fail) return e.error
    throw e
  }
}

function intArg(a: GArg, fn: string, what: string): number | undefined {
  if (a === undefined) return undefined
  const v = isMatrix(a) ? (rows(a) === 1 && cols(a) === 1 ? a[0]![0]! : null) : a
  if (isMatrix(a) && v === null) throw new Unsupported(`${fn} with an array as ${what}`)
  if (isErrorValue(v)) throw new Fail(v)
  const n = toNumber(v)
  if (isErrorValue(n)) throw new Fail(n)
  return Math.trunc(n)
}

function listArg(a: GArg): number[] | undefined {
  if (a === undefined) return undefined
  return asMatrix(a)
    .flat()
    .map((v) => {
      if (isErrorValue(v)) throw new Fail(v)
      const n = toNumber(v)
      if (isErrorValue(n)) throw new Fail(n)
      return Math.trunc(n)
    })
}

/** Whether the inputs have a header row: field_headers, or the documented automatic rule. */
function headers(code: number | undefined, values: Matrix, fn: string): { has: boolean; show: boolean } {
  if (code === undefined) {
    const first = values[0]?.[0] ?? null
    const second = values[1]?.[0] ?? null
    if (typeof first === 'string' && typeof second === 'number') return { has: true, show: false }
    if (typeof first === 'number') return { has: false, show: false }
    throw new Unsupported(`${fn} deciding on its own whether there are headers (give field_headers)`)
  }
  if (code === 0) return { has: false, show: false }
  if (code === 1) return { has: true, show: false }
  if (code === 3) return { has: true, show: true }
  if (code === 2) throw new Unsupported(`${fn} generating field headers (field_headers 2)`)
  return fail('#VALUE!')
}

/** One grouping key; text keys equal ignoring case, so case-only differences are refused. */
function keyOf(v: CellValue, fn: string, spellings: Map<string, string>): string {
  if (v === null) throw new Unsupported(`${fn} with empty cells among the fields`)
  if (isErrorValue(v)) throw new Unsupported(`${fn} with errors among the fields`)
  if (typeof v === 'string') {
    const k = `s${v.toLowerCase()}`
    const seen = spellings.get(k)
    if (seen !== undefined && seen !== v)
      throw new Unsupported(`${fn} with “${seen}” and “${v}” (Excel's grouping of case is undocumented)`)
    spellings.set(k, v)
    return k
  }
  return `${typeof v}${String(v)}`
}

function filterArg(a: GArg, n: number, _fn: string): boolean[] | null {
  if (a === undefined) return null
  const m = asMatrix(a)
  if (cols(m) !== 1 || rows(m) !== n) return fail('#VALUE!')
  return m.map((r) => {
    const v = r[0] ?? null
    if (isErrorValue(v)) throw new Fail(v)
    const t = truthy(v)
    if (isErrorValue(t)) throw new Fail(t)
    return t
  })
}

const column = (m: Matrix, c: number, idx: number[]): Matrix => idx.map((i) => [m[i]![c] ?? null])

function one(agg: Aggregator, subset: Matrix, total: Matrix): CellValue {
  return agg.run(subset, total)
}

export function groupBy(args: GArg[], agg: Aggregator): CellValue | Matrix {
  const fn = 'GROUPBY'
  return guard(() => {
    if (args[0] === undefined || args[1] === undefined) fail('#VALUE!')
    const rf = asMatrix(args[0]!)
    const vals = asMatrix(args[1]!)
    if (rows(rf) !== rows(vals)) fail('#VALUE!')
    const k = cols(rf)
    const v = cols(vals)
    const h = headers(intArg(args[3], fn, 'field_headers'), vals, fn)
    const depthIn = intArg(args[4], fn, 'total_depth')
    let depth: number
    if (depthIn === undefined) {
      if (k > 1) throw new Unsupported(`${fn} with automatic subtotals over several fields`)
      depth = 1
    } else if (Math.abs(depthIn) >= 2) {
      if (k > 1) throw new Unsupported(`${fn} with subtotals`)
      depth = Math.sign(depthIn)
    } else depth = depthIn
    const relationship = intArg(args[7], fn, 'field_relationship') ?? 0
    if (relationship !== 0 && relationship !== 1) fail('#VALUE!')
    const keep = filterArg(args[6], rows(rf), fn)
    const start = h.has ? 1 : 0
    const idx: number[] = []
    for (let i = start; i < rows(rf); i++) if (!keep || keep[i]) idx.push(i)
    if (idx.length === 0) fail('#CALC!')
    // Groups in first-seen order.
    const spellings = rf[0]!.map(() => new Map<string, string>())
    const groups = new Map<string, { key: CellValue[]; rows: number[] }>()
    for (const i of idx) {
      const key = rf[i]!.map((x) => x ?? null)
      const id = key.map((x, c) => keyOf(x, fn, spellings[c]!)).join('\u0000')
      const g = groups.get(id)
      if (g) g.rows.push(i)
      else groups.set(id, { key, rows: [i] })
    }
    const totals = Array.from({ length: v }, (_, c) => column(vals, c, idx))
    const list = [...groups.values()].map((g) => ({
      key: g.key,
      aggs: Array.from({ length: v }, (_, c) => one(agg, column(vals, c, g.rows), totals[c]!)),
    }))
    const sorts = listArg(args[5]) ?? Array.from({ length: k }, (_, i) => i + 1)
    for (const s of sorts) if (s === 0 || Math.abs(s) > k + v) fail('#VALUE!')
    if (sorts.length > 1 && sorts.some((s) => Math.abs(s) > k)) fail('#VALUE!')
    if (k > 1 && sorts.some((s) => Math.abs(s) > k))
      throw new Unsupported(`${fn} sorting several field levels by a value`)
    const at = (g: (typeof list)[number], s: number): CellValue =>
      Math.abs(s) <= k ? g.key[Math.abs(s) - 1]! : g.aggs[Math.abs(s) - k - 1]!
    const keyOrder = (a: (typeof list)[number], b: (typeof list)[number]) => {
      for (let c = 0; c < k; c++) {
        const d = sortOrder(a.key[c]!, b.key[c]!, fn)
        if (d !== 0) return d
      }
      return 0
    }
    list.sort((a, b) => {
      for (const s of sorts) {
        const x = at(a, s)
        const y = at(b, s)
        if (Math.abs(s) > k && (isErrorValue(x) || isErrorValue(y)))
          throw new Unsupported(`${fn} sorting by values with errors`)
        const d = sortOrder(x, y, fn)
        if (d !== 0) return s < 0 ? -d : d
      }
      return keyOrder(a, b)
    })
    const out: Matrix = []
    if (h.show || (args[3] === undefined && h.has && k > 1))
      out.push([...rf[0]!.map((x) => x ?? ''), ...vals[0]!.map((x) => x ?? '')])
    const total = (): CellValue[] => [
      'Total',
      ...Array.from({ length: k - 1 }, () => ''),
      ...totals.map((t) => one(agg, t, t)),
    ]
    if (depth < 0) out.push(total())
    for (const g of list) out.push([...g.key, ...g.aggs])
    if (depth > 0) out.push(total())
    return out
  })
}

export function pivotBy(args: GArg[], agg: Aggregator): CellValue | Matrix {
  const fn = 'PIVOTBY'
  return guard(() => {
    if (args[0] === undefined || args[1] === undefined || args[2] === undefined) fail('#VALUE!')
    const rf = asMatrix(args[0]!)
    const cf = asMatrix(args[1]!)
    const vals = asMatrix(args[2]!)
    if (rows(rf) !== rows(vals) || rows(cf) !== rows(vals)) fail('#VALUE!')
    if (cols(rf) !== 1 || cols(cf) !== 1 || cols(vals) !== 1)
      throw new Unsupported(`${fn} with several row fields, column fields or values columns`)
    const h = headers(intArg(args[4], fn, 'field_headers'), vals, fn)
    if (h.show) throw new Unsupported(`${fn} showing field headers`)
    const depth = (a: GArg, what: string) => {
      const d = intArg(a, fn, what)
      if (d === undefined) return 1
      return Math.abs(d) >= 2 ? Math.sign(d) : d
    }
    const rowDepth = depth(args[5], 'row_total_depth')
    const colDepth = depth(args[7], 'col_total_depth')
    const relative = intArg(args[10], fn, 'relative_to') ?? 0
    if (relative < 0 || relative > 4) fail('#VALUE!')
    if (relative > 2) throw new Unsupported(`${fn} relative to parent totals`)
    const keep = filterArg(args[9], rows(rf), fn)
    const start = h.has ? 1 : 0
    const idx: number[] = []
    for (let i = start; i < rows(rf); i++) if (!keep || keep[i]) idx.push(i)
    if (idx.length === 0) fail('#CALC!')
    const keysOf = (m: Matrix) => {
      const spellings = new Map<string, string>()
      const map = new Map<string, { key: CellValue; rows: number[] }>()
      const ids: string[] = []
      for (const i of idx) {
        const x = m[i]![0] ?? null
        const id = keyOf(x, fn, spellings)
        ids[i] = id
        const g = map.get(id)
        if (g) g.rows.push(i)
        else map.set(id, { key: x, rows: [i] })
      }
      return { groups: [...map.values()], ids }
    }
    const R = keysOf(rf)
    const C = keysOf(cf)
    const values = (rowsIn: number[]) => rowsIn.map((i) => [vals[i]![0] ?? null])
    const inter = (a: number[], b: number[]) => {
      const s = new Set(b)
      return a.filter((i) => s.has(i))
    }
    const totalSet = (rowRows: number[], colRows: number[]) =>
      relative === 0 ? colRows : relative === 1 ? rowRows : idx
    const cell = (rowRows: number[], colRows: number[]): CellValue => {
      const sub = inter(rowRows, colRows)
      if (sub.length === 0) return ''
      return one(agg, values(sub), values(totalSet(rowRows, colRows)))
    }
    const order = (
      groups: Array<{ key: CellValue; rows: number[] }>,
      sortsIn: number[] | undefined,
    ) => {
      const sorts = sortsIn ?? [1]
      for (const s of sorts) if (s === 0 || Math.abs(s) > 2) fail('#VALUE!')
      if (sorts.length > 1) fail('#VALUE!')
      const s = sorts[0]!
      const withTotal = groups.map((g) => ({ g, t: Math.abs(s) === 2 ? cell(g.rows, idx) : null }))
      withTotal.sort((a, b) => {
        const d =
          Math.abs(s) === 1 ? sortOrder(a.g.key, b.g.key, fn) : sortOrder(a.t!, b.t!, fn)
        if (d !== 0) return s < 0 ? -d : d
        return sortOrder(a.g.key, b.g.key, fn)
      })
      return withTotal.map((x) => x.g)
    }
    const rowsSorted = order(R.groups, listArg(args[6]))
    const colsSorted = order(C.groups, listArg(args[8]))
    const colList: Array<{ label: CellValue; rows: number[] }> = colsSorted.map((g) => ({
      label: g.key,
      rows: g.rows,
    }))
    if (colDepth > 0) colList.push({ label: 'Total', rows: idx })
    if (colDepth < 0) colList.unshift({ label: 'Total', rows: idx })
    const rowList: Array<{ label: CellValue; rows: number[] }> = rowsSorted.map((g) => ({
      label: g.key,
      rows: g.rows,
    }))
    if (rowDepth > 0) rowList.push({ label: 'Total', rows: idx })
    if (rowDepth < 0) rowList.unshift({ label: 'Total', rows: idx })
    const out: Matrix = [['', ...colList.map((c) => c.label)]]
    for (const r of rowList) out.push([r.label, ...colList.map((c) => cell(r.rows, c.rows))])
    return out
  })
}

/** PERCENTOF(data_subset, data_all) = SUM(subset) / SUM(all). */
export function percentOf(subset: Matrix, all: Matrix): CellValue {
  const sum = (m: Matrix): number | ErrorValue => {
    let s = 0
    for (const v of m.flat()) {
      if (isErrorValue(v)) return v
      if (typeof v === 'number') s += v
    }
    return s
  }
  const a = sum(subset)
  const b = sum(all)
  if (isErrorValue(a)) return a
  if (isErrorValue(b)) return b
  return b === 0 ? err('#DIV/0!') : a / b
}
