import { format as formatNumber } from 'numfmt'
import { isErrorValue, type CellValue, type ErrorValue } from './workbook'

/**
 * The values formulas work with (ECMA-376 Part 1 §18.17.2): scalars, arrays
 * (rows of scalars), references to a rectangle of cells, and LAMBDA
 * functions; with Excel's coercions, comparisons and element-wise lifting.
 * Shared by the evaluator (calc.ts) and its function families.
 */

export type Matrix = CellValue[][]
export type Rect = { top: number; left: number; bottom: number; right: number }
export type RefVal = { ref: { sheet: string } & Rect }
export type LambdaVal = {
  /** `eta`: an eta-reduced lambda — a worksheet function passed by name (`GROUPBY(…,SUM)`, files: `_xleta.SUM`). */
  lambda: { params: string[]; body: unknown; env: Env | null; home: string; eta?: string }
}
/** A reference of several areas: a range union `(A1:B2,D4)` (ECMA-376 Part 1 §18.17.2.2, the union operator). */
export type AreasVal = { areas: Array<RefVal['ref']> }
/** A parameter the caller left out (LAMBDA's ISOMITTED). */
export type OmittedVal = { omitted: true }
export type Val = CellValue | Matrix | RefVal | AreasVal | LambdaVal | OmittedVal

/** Names bound by LET and LAMBDA, innermost first. */
export type Env = { names: Map<string, Val>; parent: Env | null }

/** A formula this engine can't calculate; the reason is shown (a function name, "a circular reference"). */
export class Unsupported extends Error {}

export const err = (code: string): ErrorValue => ({ error: code })
export const isMatrix = (v: unknown): v is Matrix => Array.isArray(v)
export const isRef = (v: unknown): v is RefVal => typeof v === 'object' && v !== null && 'ref' in v
export const isAreas = (v: unknown): v is AreasVal =>
  typeof v === 'object' && v !== null && 'areas' in v
export const isLambda = (v: unknown): v is LambdaVal =>
  typeof v === 'object' && v !== null && 'lambda' in v
export const isOmitted = (v: unknown): v is OmittedVal =>
  typeof v === 'object' && v !== null && 'omitted' in v

export const rows = (m: Matrix) => m.length
export const cols = (m: Matrix) => m[0]?.length ?? 0
export const asMatrix = (v: CellValue | Matrix): Matrix => (isMatrix(v) ? v : [[v]])
export const isMulti = (r: Rect) => r.top !== r.bottom || r.left !== r.right

export function toNumber(v: CellValue): number | ErrorValue {
  if (v === null) return 0
  if (isErrorValue(v)) return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  const t = v.trim()
  if (t === '') return err('#VALUE!')
  const n = Number(t)
  return Number.isFinite(n) ? n : err('#VALUE!')
}

export function truthy(v: CellValue): boolean | ErrorValue {
  if (v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (isErrorValue(v)) return v
  const u = v.toUpperCase()
  if (u === 'TRUE') return true
  if (u === 'FALSE') return false
  return err('#VALUE!')
}

export function toText(v: CellValue): string | ErrorValue {
  if (v === null) return ''
  if (isErrorValue(v)) return v
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return formatNumber('General', v, { locale: 'en' })
  return v
}

/** Excel's ordering across types for the comparison operators: numbers < text < booleans; text compares without case. */
export function compare(a: CellValue, b: CellValue): number {
  const rank = (x: CellValue) => (typeof x === 'number' ? 0 : typeof x === 'string' ? 1 : 2)
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  if (typeof a === 'string') {
    const x = a.toLowerCase()
    const y = (b as string).toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  }
  const x = Number(a)
  const y = Number(b)
  return x < y ? -1 : x > y ? 1 : 0
}

export function binary(op: string, a: CellValue, b: CellValue): CellValue {
  if (isErrorValue(a)) return a
  if (isErrorValue(b)) return b
  if (op === '&') {
    const x = toText(a)
    const y = toText(b)
    return isErrorValue(x) ? x : isErrorValue(y) ? y : x + y
  }
  if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
    const c = compare(a, b)
    return op === '='
      ? c === 0
      : op === '<>'
        ? c !== 0
        : op === '<'
          ? c < 0
          : op === '>'
            ? c > 0
            : op === '<='
              ? c <= 0
              : c >= 0
  }
  const x = toNumber(a)
  const y = toNumber(b)
  if (isErrorValue(x)) return x
  if (isErrorValue(y)) return y
  switch (op) {
    case '+':
      return x + y
    case '-':
      return x - y
    case '*':
      return x * y
    case '/':
      return y === 0 ? err('#DIV/0!') : x / y
    case '^': {
      if (x === 0 && y === 0) return err('#NUM!')
      const p = Math.pow(x, y)
      return Number.isFinite(p) ? p : err('#NUM!')
    }
  }
  throw new Unsupported(`the operator ${op}`)
}

/**
 * Applies `f` element by element when any argument is an array: arrays one
 * row or one column high repeat along that side; positions past a shorter
 * array are #N/A (Excel's broadcasting).
 */
export function liftN(
  args: Array<CellValue | Matrix>,
  f: (xs: CellValue[]) => CellValue,
): CellValue | Matrix {
  if (!args.some(isMatrix)) return f(args as CellValue[])
  const ms = args.map((a) => (isMatrix(a) ? a : null))
  const h = Math.max(...ms.map((m) => (m ? rows(m) : 1)))
  const w = Math.max(...ms.map((m) => (m ? cols(m) : 1)))
  const at = (a: CellValue | Matrix, r: number, c: number): CellValue => {
    if (!isMatrix(a)) return a
    const rr = rows(a) === 1 ? 0 : r
    const cc = cols(a) === 1 ? 0 : c
    return rr < rows(a) && cc < (a[rr]?.length ?? 0) ? (a[rr]![cc] ?? null) : err('#N/A')
  }
  const out: Matrix = []
  for (let r = 0; r < h; r++) {
    const row: CellValue[] = []
    for (let c = 0; c < w; c++) row.push(f(args.map((a) => at(a, r, c))))
    out.push(row)
  }
  return out
}

export function lift(
  a: CellValue | Matrix,
  b: CellValue | Matrix | null,
  f: (x: CellValue, y: CellValue | null) => CellValue,
): CellValue | Matrix {
  if (b === null) return liftN([a], ([x]) => f(x!, null))
  return liftN([a, b], ([x, y]) => f(x!, y!))
}

/** A JS date (formulajs builds them in local time) → an Excel serial number. */
export function dateToSerial(d: Date): number {
  const utc = Date.UTC(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  )
  return utc / 86_400_000 + 25_569
}
