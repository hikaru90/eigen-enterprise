import { parse } from '@borgar/fx'
import { parseA1Ref } from '@borgar/fx/xlsx'
import * as F from '@formulajs/formulajs'
import { format as formatNumber } from 'numfmt'
import { cellKey, cellName } from './ref'
import { parseableTokens } from './shift'
import { isErrorValue, type CellValue, type ErrorValue, type Workbook } from './workbook'

/**
 * Formula evaluation for the editor (ECMA-376 Part 1 §18.17): formulas are
 * parsed by @borgar/fx (MIT) and evaluated here — references, defined names,
 * the operators with Excel's coercions and comparisons — with the worksheet
 * functions of @formulajs/formulajs (MIT).
 *
 * What this engine cannot calculate (a function neither provides, OFFSET and
 * INDIRECT, table references, array formulas, a circular reference) is never
 * guessed: the cell keeps the value Excel last calculated, and the result
 * says why (`kept`), so the editor can show it and the save leaves that
 * cached value as it was.
 */

export type Computed =
  { value: CellValue; kept: false } | { value: CellValue; kept: true; reason: string }

type Matrix = CellValue[][]
type RefVal = { ref: { sheet: string; top: number; left: number; bottom: number; right: number } }
type Val = CellValue | Matrix | RefVal

/** A formula this engine can't calculate; the reason is shown (a function name, "OFFSET", "a circular reference"). */
export class Unsupported extends Error {}

type Node = { type: string; [k: string]: unknown }

const isMatrix = (v: Val): v is Matrix => Array.isArray(v)
const isRef = (v: Val): v is RefVal => typeof v === 'object' && v !== null && 'ref' in v
const err = (code: string): ErrorValue => ({ error: code })

/** Functions that need the reference itself or that this engine refuses rather than approximate. */
const REFUSED = new Set([
  'OFFSET',
  'INDIRECT',
  'CELL',
  'INFO',
  'LET',
  'LAMBDA',
  'GETPIVOTDATA',
  'CUBEVALUE',
  'CUBEMEMBER',
  'RTD',
  'WEBSERVICE',
  'FILTERXML',
  'IMAGE',
  'XLOOKUP',
  'XMATCH',
  'FILTER',
  'SEQUENCE',
  'RANDARRAY',
  'SORTBY',
  'MAP',
  'REDUCE',
  'SCAN',
  'BYROW',
  'BYCOL',
  'MAKEARRAY',
])

const FJ_ERRORS = F.utils.errors as Record<string, Error>
const FJ_BY_CODE = new Map<string, Error>(Object.values(FJ_ERRORS).map((e) => [e.message, e]))

export type Calc = {
  /** The value of any cell: a literal as it is, a formula calculated (or kept, with why). */
  cell(sheet: string, row: number, col: number): Computed
  /** Evaluates a formula text as if it were in `sheet` (for previews and checks). */
  evaluate(sheet: string, formula: string): Computed
}

export function createCalc(wb: Workbook): Calc {
  const memo = new Map<string, Computed>()
  const busy = new Set<string>()
  const asts = new Map<string, Node>()
  const sheetIndex = (name: string) => wb.findSheet(name)?.index ?? -1

  function ast(formula: string): Node {
    const hit = asts.get(formula)
    if (hit) return hit
    let node: Node
    try {
      node = parse(parseableTokens(formula) as never) as unknown as Node
    } catch (e) {
      throw new Unsupported(
        `the formula can't be read (${e instanceof Error ? e.message : String(e)})`,
      )
    }
    asts.set(formula, node)
    return node
  }

  function cell(sheet: string, row: number, col: number): Computed {
    const info = wb.findSheet(sheet)
    if (!info || info.kind !== 'worksheet') return { value: err('#REF!'), kept: false }
    const key = `${info.part}|${cellKey(row, col)}`
    const hit = memo.get(key)
    if (hit) return hit
    const data = wb.sheet(info.name).cells.get(cellKey(row, col))
    if (!data) return { value: null, kept: false }
    if (data.formulaType === 'array' || data.formulaType === 'dataTable' || data.inArrayOf)
      return remember(key, {
        value: data.value,
        kept: true,
        reason: data.formulaType === 'dataTable' ? 'a data table' : 'an array formula',
      })
    if (data.formula === null) return remember(key, { value: data.value, kept: false })
    if (busy.has(key))
      throw new Unsupported(`a circular reference (${info.name}!${cellName(data)})`)
    busy.add(key)
    try {
      const v = scalar(evalNode(ast(data.formula), info.name, 0))
      return remember(key, { value: v === null ? 0 : v, kept: false })
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e
      return remember(key, { value: data.value, kept: true, reason: e.message })
    } finally {
      busy.delete(key)
    }
  }

  function remember(key: string, c: Computed): Computed {
    memo.set(key, c)
    return c
  }

  /** A referenced cell's value; a referenced formula that can't be calculated makes this one unsupported too. */
  function refCell(sheet: string, row: number, col: number): CellValue {
    const c = cell(sheet, row, col)
    if (c.kept) {
      const info = wb.findSheet(sheet)!
      const data = wb.sheet(info.name).cells.get(cellKey(row, col))
      // Array and data-table results are what Excel calculated: usable as they are.
      if (
        data &&
        (data.formulaType === 'array' || data.formulaType === 'dataTable' || data.inArrayOf)
      )
        return c.value
      throw new Unsupported(c.reason)
    }
    return c.value
  }

  function materialize(v: Val): CellValue | Matrix {
    if (!isRef(v)) return v
    const { sheet, top, left, bottom, right } = v.ref
    if (top === bottom && left === right) return refCell(sheet, top, left)
    const out: Matrix = []
    for (let r = top; r <= bottom; r++) {
      const row: CellValue[] = []
      for (let c = left; c <= right; c++) row.push(refCell(sheet, r, c))
      out.push(row)
    }
    return out
  }

  function scalar(v: Val): CellValue {
    const m = materialize(v)
    if (!isMatrix(m)) return m
    return m[0]?.[0] ?? null
  }

  function resolveRef(text: string, home: string): RefVal | CellValue {
    const ref = parseA1Ref(text) as
      | {
          workbookName?: string
          sheetName?: string
          range?: {
            top: number | null
            left: number | null
            bottom: number | null
            right: number | null
          }
          name?: string
        }
      | undefined
    if (!ref) throw new Unsupported(`the reference ${text}`)
    if (ref.workbookName) throw new Unsupported('a reference to another workbook')
    const sheetName = ref.sheetName || home
    const info = wb.findSheet(sheetName)
    if (!info || info.kind !== 'worksheet') return err('#REF!')
    const r = ref.range!
    const data = wb.sheet(info.name)
    const top = r.top ?? 0
    const bottom = r.bottom ?? Math.max(top, data.maxRow)
    const left = r.left ?? 0
    const right = r.right ?? Math.max(left, data.maxCol)
    return { ref: { sheet: info.name, top, left, bottom, right } }
  }

  function definedName(name: string, home: string, depth: number): Val {
    const names = wb.definedNames()
    const k = name.toLowerCase()
    const local = names.find((n) => n.name.toLowerCase() === k && n.localSheet === sheetIndex(home))
    const global = names.find((n) => n.name.toLowerCase() === k && n.localSheet === null)
    const def = local ?? global
    if (!def) return err('#NAME?')
    if (depth > 20) throw new Unsupported(`the name ${name} refers to itself`)
    return evalNode(ast(def.formula), home, depth + 1)
  }

  function evalNode(node: Node, home: string, depth: number): Val {
    switch (node.type) {
      case 'Literal':
        return node.value as number | string | boolean
      case 'ErrorLiteral':
        return err(String(node.value))
      case 'ReferenceIdentifier': {
        const kind = node.kind as string
        if (kind === 'name') return definedName(String(node.value), home, depth)
        if (kind === 'table') throw new Unsupported('table references')
        return resolveRef(String(node.value), home)
      }
      case 'UnaryExpression': {
        const [arg] = node.arguments as Node[]
        const op = node.operator as string
        if (op === '#') throw new Unsupported('spilled ranges')
        const v = evalNode(arg!, home, depth)
        if (op === '@') return scalar(v)
        return lift(materialize(v), null, (a) => {
          const n = toNumber(a)
          if (isErrorValue(n)) return n
          return op === '-' ? -n : op === '%' ? n / 100 : n
        })
      }
      case 'BinaryExpression': {
        const op = node.operator as string
        const [l, r] = node.arguments as Node[]
        if (op === ':' || op === ' ' || op === ',')
          throw new Unsupported(op === ':' ? 'a computed range' : 'range unions and intersections')
        const a = materialize(evalNode(l!, home, depth))
        const b = materialize(evalNode(r!, home, depth))
        return lift(a, b, (x, y) => binary(op, x, y!))
      }
      case 'CallExpression':
        return call(node, home, depth)
      case 'ArrayExpression':
        return (node.elements as Node[][]).map((row) =>
          row.map((el) => scalar(evalNode(el, home, depth))),
        )
      default:
        throw new Unsupported(
          node.type === 'LambdaExpression' || node.type === 'LetExpression'
            ? 'LAMBDA and LET'
            : `a ${node.type}`,
        )
    }
  }

  function call(node: Node, home: string, depth: number): Val {
    const raw = ((node.callee as { name: string }).name ?? '').toUpperCase()
    const name = raw.replace(/^_XLFN\.(_XLWS\.)?|^_XLWS\./, '')
    const args = node.arguments as Node[]
    const arg = (i: number) => (args[i] ? evalNode(args[i]!, home, depth) : null)
    switch (name) {
      case 'IF': {
        const c = scalar(arg(0))
        if (isErrorValue(c)) return c
        const t = truthy(c)
        if (isErrorValue(t)) return t
        if (t) return args[1] ? arg(1) : true
        return args[2] ? arg(2) : false
      }
      case 'IFERROR':
      case 'IFNA': {
        const v = materialize(arg(0))
        const bad = (x: CellValue) => isErrorValue(x) && (name === 'IFERROR' || x.error === '#N/A')
        if (isMatrix(v)) {
          const alt = scalar(arg(1))
          return v.map((row) => row.map((x) => (bad(x) ? alt : x)))
        }
        return bad(v) ? arg(1) : v
      }
      case 'ROW':
      case 'COLUMN': {
        if (args.length === 0) throw new Unsupported(`${name} without a reference`)
        const r = arg(0)
        if (!isRef(r)) return err('#VALUE!')
        return (name === 'ROW' ? r.ref.top : r.ref.left) + 1
      }
      case 'ROWS':
      case 'COLUMNS': {
        const r = arg(0)
        if (isRef(r))
          return name === 'ROWS' ? r.ref.bottom - r.ref.top + 1 : r.ref.right - r.ref.left + 1
        const m = materialize(r)
        if (isErrorValue(m)) return m
        return isMatrix(m) ? (name === 'ROWS' ? m.length : (m[0]?.length ?? 0)) : 1
      }
      case 'ISBLANK':
        return scalar(arg(0)) === null
      case 'TEXT': {
        const v = scalar(arg(0))
        const code = scalar(arg(1))
        if (isErrorValue(v)) return v
        if (isErrorValue(code)) return code
        try {
          return formatNumber(String(code ?? ''), v ?? 0, { locale: 'en', throws: true })
        } catch {
          return err('#VALUE!')
        }
      }
      case 'HYPERLINK':
        return args[1] ? scalar(arg(1)) : scalar(arg(0))
    }
    if (REFUSED.has(name)) throw new Unsupported(name)
    const fn = lookupFunction(name)
    if (!fn) throw new Unsupported(name)
    const values = args.map((a) => toFormulaJs(materialize(evalNode(a, home, depth))))
    let out: unknown
    try {
      out = fn(...values)
    } catch (e) {
      throw new Unsupported(`${name} (${e instanceof Error ? e.message : String(e)})`)
    }
    return fromFormulaJs(out, name)
  }

  return {
    cell,
    evaluate(sheet, formula) {
      try {
        const v = scalar(evalNode(ast(formula), sheet, 0))
        return { value: v === null ? 0 : v, kept: false }
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e
        return { value: null, kept: true, reason: e.message }
      }
    },
  }
}

/** The @formulajs/formulajs implementation of an Excel function name ("STDEV.S" → F.STDEV.S), else null. */
function lookupFunction(name: string): ((...a: unknown[]) => unknown) | null {
  const lib = F as unknown as Record<string, unknown>
  let cur: unknown = lib
  for (const part of name.split('.')) {
    cur =
      (cur && typeof cur === 'object') || typeof cur === 'function'
        ? (cur as Record<string, unknown>)[part]
        : undefined
  }
  if (typeof cur === 'function') return cur as (...a: unknown[]) => unknown
  const flat = lib[name.replace(/\./g, '')]
  return typeof flat === 'function' ? (flat as (...a: unknown[]) => unknown) : null
}

function toFormulaJs(v: CellValue | Matrix): unknown {
  const one = (x: CellValue) => (isErrorValue(x) ? (FJ_BY_CODE.get(x.error) ?? FJ_ERRORS.value) : x)
  return isMatrix(v) ? v.map((row) => row.map(one)) : one(v)
}

function fromFormulaJs(out: unknown, name: string): Val {
  if (out instanceof Error) return err(out.message.startsWith('#') ? out.message : '#VALUE!')
  if (out instanceof Date) return dateToSerial(out)
  if (typeof out === 'number') return Number.isFinite(out) ? out : err('#NUM!')
  if (typeof out === 'string' || typeof out === 'boolean') return out
  if (out === null) return null
  if (Array.isArray(out)) {
    const rows = (Array.isArray(out[0]) ? out : [out]) as unknown[][]
    return rows.map((row) => row.map((x) => scalarOf(fromFormulaJs(x, name))))
  }
  throw new Unsupported(`${name} (no result)`)
}

const scalarOf = (v: Val): CellValue => (Array.isArray(v) ? (v[0]?.[0] ?? null) : (v as CellValue))

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

function toNumber(v: CellValue): number | ErrorValue {
  if (v === null) return 0
  if (isErrorValue(v)) return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  const t = v.trim()
  if (t === '') return err('#VALUE!')
  const n = Number(t)
  return Number.isFinite(n) ? n : err('#VALUE!')
}

function truthy(v: CellValue): boolean | ErrorValue {
  if (v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (isErrorValue(v)) return v
  const u = v.toUpperCase()
  if (u === 'TRUE') return true
  if (u === 'FALSE') return false
  return err('#VALUE!')
}

function toText(v: CellValue): string | ErrorValue {
  if (v === null) return ''
  if (isErrorValue(v)) return v
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return formatNumber('General', v, { locale: 'en' })
  return v
}

/** Excel's ordering across types: numbers < text < booleans; text compares without case. */
function compare(a: CellValue, b: CellValue): number {
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

function binary(op: string, a: CellValue, b: CellValue): CellValue {
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

/** Applies an operation element by element when either side is an array (shorter sides repeat when they are 1 wide). */
function lift(
  a: CellValue | Matrix,
  b: CellValue | Matrix | null,
  f: (x: CellValue, y: CellValue | null) => CellValue,
): CellValue | Matrix {
  if (!isMatrix(a) && (b === null || !isMatrix(b))) return f(a, b as CellValue | null)
  const am = isMatrix(a) ? a : [[a]]
  const bm = b === null ? null : isMatrix(b) ? b : [[b]]
  const rows = Math.max(am.length, bm?.length ?? 0)
  const cols = Math.max(am[0]?.length ?? 0, bm?.[0]?.length ?? 0)
  const at = (m: Matrix, r: number, c: number): CellValue => {
    const rr = m.length === 1 ? 0 : r
    const cc = (m[0]?.length ?? 0) === 1 ? 0 : c
    return rr < m.length && cc < (m[rr]?.length ?? 0) ? (m[rr]![cc] ?? null) : err('#N/A')
  }
  const out: Matrix = []
  for (let r = 0; r < rows; r++) {
    const row: CellValue[] = []
    for (let c = 0; c < cols; c++) row.push(f(at(am, r, c), bm ? at(bm, r, c) : null))
    out.push(row)
  }
  return out
}
