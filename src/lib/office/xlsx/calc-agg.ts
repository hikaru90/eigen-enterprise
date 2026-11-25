import { err, Unsupported, type Matrix } from './calc-values'
import { parseRange, type Range } from './ref'
import { parseableTokens } from './shift'
import { isErrorValue, type CellValue, type SheetInfo, type Workbook } from './workbook'
import { kid, kids, REL } from './xml'

/**
 * SUBTOTAL and AGGREGATE (Microsoft's function reference), over the cells
 * of references rather than their values: rows hidden by a filter are
 * always left out, rows hidden otherwise only by 101–111 (and AGGREGATE's
 * "ignore hidden rows" options), and cells that are themselves a SUBTOTAL
 * or AGGREGATE are left out so totals don't count twice. Columns hidden
 * don't matter (both functions are for vertical ranges). A hidden row in a
 * filter range with an active filter counts as filtered out.
 *
 * Also the matrix functions formulajs lacks: MDETERM, MINVERSE.
 */

/** SUBTOTAL 1–11 / AGGREGATE 1–19 → what they calculate. */
export const AGG_FUNCTIONS = [
  '',
  'AVERAGE',
  'COUNT',
  'COUNTA',
  'MAX',
  'MIN',
  'PRODUCT',
  'STDEV.S',
  'STDEV.P',
  'SUM',
  'VAR.S',
  'VAR.P',
  'MEDIAN',
  'MODE.SNGL',
  'LARGE',
  'SMALL',
  'PERCENTILE.INC',
  'QUARTILE.INC',
  'PERCENTILE.EXC',
  'QUARTILE.EXC',
] as const

/**
 * One aggregation over the values of a range (range semantics: text and
 * TRUE/FALSE are not numbers; COUNTA counts every non-empty value). The
 * first error is the result unless errors are ignored (COUNT and COUNTA
 * never return them).
 */
export function aggregateValues(
  fnNum: number,
  values: CellValue[],
  ignoreErrors: boolean,
  k?: CellValue,
): CellValue {
  const name = AGG_FUNCTIONS[fnNum]
  if (!name) return err('#VALUE!')
  if (name === 'COUNTA')
    return values.filter((v) => v !== null && !(ignoreErrors && isErrorValue(v))).length
  if (name === 'COUNT') return values.filter((v) => typeof v === 'number').length
  if (!ignoreErrors) {
    const e = values.find(isErrorValue)
    if (e) return e
  }
  const xs = values.filter((v): v is number => typeof v === 'number')
  const n = xs.length
  const sum = xs.reduce((a, b) => a + b, 0)
  const mean = sum / n
  const ss = xs.reduce((a, b) => a + (b - mean) ** 2, 0)
  switch (name) {
    case 'AVERAGE':
      return n === 0 ? err('#DIV/0!') : mean
    case 'MAX':
      return n === 0 ? 0 : Math.max(...xs)
    case 'MIN':
      return n === 0 ? 0 : Math.min(...xs)
    case 'PRODUCT':
      return n === 0 ? 0 : xs.reduce((a, b) => a * b, 1)
    case 'SUM':
      return sum
    case 'STDEV.S':
      return n < 2 ? err('#DIV/0!') : Math.sqrt(ss / (n - 1))
    case 'STDEV.P':
      return n === 0 ? err('#DIV/0!') : Math.sqrt(ss / n)
    case 'VAR.S':
      return n < 2 ? err('#DIV/0!') : ss / (n - 1)
    case 'VAR.P':
      return n === 0 ? err('#DIV/0!') : ss / n
    case 'MEDIAN': {
      if (n === 0) return err('#NUM!')
      const s = [...xs].sort((a, b) => a - b)
      return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
    }
    case 'MODE.SNGL': {
      const counts = new Map<number, number>()
      for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1)
      let best: number | null = null
      let most = 1
      for (const x of xs) {
        const c = counts.get(x)!
        if (c > most) {
          most = c
          best = x
        }
      }
      return best === null ? err('#N/A') : best
    }
  }
  // The array form: k is required.
  if (k === undefined) return err('#VALUE!')
  if (isErrorValue(k)) return k
  if (typeof k !== 'number') return err('#VALUE!')
  const s = [...xs].sort((a, b) => a - b)
  const inc = (p: number): CellValue => {
    if (n === 0 || p < 0 || p > 1) return err('#NUM!')
    const r = p * (n - 1)
    const lo = Math.floor(r)
    return lo + 1 < n ? s[lo]! + (r - lo) * (s[lo + 1]! - s[lo]!) : s[lo]!
  }
  const exc = (p: number): CellValue => {
    const r = p * (n + 1)
    if (n === 0 || p <= 0 || p >= 1 || r < 1 || r > n) return err('#NUM!')
    const lo = Math.floor(r)
    return lo < n ? s[lo - 1]! + (r - lo) * (s[lo]! - s[lo - 1]!) : s[lo - 1]!
  }
  switch (name) {
    case 'LARGE':
    case 'SMALL': {
      const i = Math.ceil(k)
      if (i < 1 || i > n) return err('#NUM!')
      return name === 'LARGE' ? s[n - i]! : s[i - 1]!
    }
    case 'PERCENTILE.INC':
      return inc(k)
    case 'PERCENTILE.EXC':
      return exc(k)
    case 'QUARTILE.INC': {
      const q = Math.trunc(k)
      return q < 0 || q > 4 ? err('#NUM!') : inc(q / 4)
    }
    case 'QUARTILE.EXC': {
      const q = Math.trunc(k)
      return q < 1 || q > 3 ? err('#NUM!') : exc(q / 4)
    }
  }
  return err('#VALUE!')
}

/** The ranges of a sheet with an active filter (the sheet's AutoFilter, its tables' filters), data rows only. */
export function filterRanges(wb: Workbook, info: SheetInfo): Range[] {
  const out: Range[] = []
  const add = (af: Element | null) => {
    if (!af || kids(af, 'filterColumn').length === 0) return
    const r = parseRange(af.getAttribute('ref') ?? '')
    if (r) out.push({ ...r, top: r.top + 1 })
  }
  add(kid(wb.pkg.xml(info.part).documentElement!, 'autoFilter'))
  for (const rel of wb.pkg.relationships(info.part)) {
    if (rel.external || rel.type !== `${REL}table` || !rel.part || !wb.pkg.has(rel.part)) continue
    add(kid(wb.pkg.xml(rel.part).documentElement!, 'autoFilter'))
  }
  return out
}

/** A formula that calls SUBTOTAL or AGGREGATE (such cells are left out of other totals). */
export function isNestedTotal(formula: string): boolean {
  try {
    return parseableTokens(formula).some(
      (t) =>
        t.type === 'func' &&
        /^(_xlfn\.)?(SUBTOTAL|AGGREGATE)$/i.test(t.value),
    )
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// MDETERM, MINVERSE

function numbers(m: Matrix): number[][] | CellValue {
  const h = m.length
  const w = m[0]?.length ?? 0
  if (h !== w || h === 0) return err('#VALUE!')
  const out: number[][] = []
  for (const row of m) {
    const r: number[] = []
    for (const v of row) {
      if (isErrorValue(v)) return v
      if (typeof v !== 'number') return err('#VALUE!')
      r.push(v)
    }
    out.push(r)
  }
  return out
}

/** LU decomposition with partial pivoting: the determinant (Excel calculates it to about 16 digits the same way). */
export function mdeterm(m: Matrix): CellValue {
  const a = numbers(m)
  if (!Array.isArray(a)) return a
  const n = a.length
  let det = 1
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r
    if (a[p]![c] === 0) return 0
    if (p !== c) {
      ;[a[p], a[c]] = [a[c]!, a[p]!]
      det = -det
    }
    det *= a[c]![c]!
    for (let r = c + 1; r < n; r++) {
      const f = a[r]![c]! / a[c]![c]!
      for (let k = c; k < n; k++) a[r]![k]! -= f * a[c]![k]!
    }
  }
  return det
}

/** Gauss–Jordan inverse; a singular matrix is #NUM!. */
export function minverse(m: Matrix): CellValue | Matrix {
  const a = numbers(m)
  if (!Array.isArray(a)) return a
  const n = a.length
  const inv = a.map((_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r
    if (Math.abs(a[p]![c]!) < 1e-300) return err('#NUM!')
    ;[a[p], a[c]] = [a[c]!, a[p]!]
    ;[inv[p], inv[c]] = [inv[c]!, inv[p]!]
    const d = a[c]![c]!
    for (let k = 0; k < n; k++) {
      a[c]![k]! /= d
      inv[c]![k]! /= d
    }
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = a[r]![c]!
      if (f === 0) continue
      for (let k = 0; k < n; k++) {
        a[r]![k]! -= f * a[c]![k]!
        inv[r]![k]! -= f * inv[c]![k]!
      }
    }
  }
  return inv
}

/** Thrown for a SUBTOTAL/AGGREGATE argument that is not a reference where Excel needs one. */
export const needsReference = (fn: string) =>
  new Unsupported(`${fn} over an array (Excel's reference form needs cell references)`)
