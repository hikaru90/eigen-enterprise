import {
  asMatrix,
  cols,
  err,
  isMatrix,
  rows,
  toNumber,
  toText,
  truthy,
  Unsupported,
  type Matrix,
} from './calc-values'
import { isErrorValue, type CellValue, type ErrorValue } from './workbook'

/**
 * Excel's dynamic-array functions (Microsoft 365) as Microsoft's function
 * reference documents them: lookups (XLOOKUP/XMATCH's matching), FILTER,
 * SORT, SORTBY, UNIQUE, SEQUENCE, RANDARRAY, TAKE, DROP, EXPAND, VSTACK,
 * HSTACK, TOCOL, TOROW, CHOOSECOLS, CHOOSEROWS, WRAPROWS, WRAPCOLS,
 * TEXTSPLIT, TRANSPOSE. (formulajs has some of these names, with different
 * semantics, so they are implemented here.) What Excel doesn't document —
 * where SORT puts blank cells, how its binary search treats unsorted data —
 * is refused (`Unsupported`), not guessed.
 */

/** An argument: a value, an array, or undefined when it was left out. */
export type Arg = CellValue | Matrix | undefined

/** An error result that ends the function (its error is the result). */
class Fail {
  constructor(readonly error: ErrorValue) {}
}
const fail = (code: string): never => {
  throw new Fail(err(code))
}

function one(a: Arg, fn: string, what: string): CellValue | undefined {
  if (a === undefined) return undefined
  if (!isMatrix(a)) return a
  if (rows(a) === 1 && cols(a) === 1) return a[0]![0]!
  throw new Unsupported(`${fn} with an array as its ${what}`)
}

function num(a: Arg, fn: string, what: string, def?: number): number {
  const v = one(a, fn, what)
  if (v === undefined) {
    if (def === undefined) fail('#VALUE!')
    return def!
  }
  if (isErrorValue(v)) throw new Fail(v)
  const n = toNumber(v)
  if (isErrorValue(n)) throw new Fail(n)
  return n
}

function bool(a: Arg, fn: string, what: string, def: boolean): boolean {
  const v = one(a, fn, what)
  if (v === undefined || v === null) return def
  if (isErrorValue(v)) throw new Fail(v)
  const t = truthy(v)
  if (isErrorValue(t)) throw new Fail(t)
  return t
}

function matrixArg(a: Arg): Matrix {
  if (a === undefined) fail('#VALUE!')
  if (!isMatrix(a) && isErrorValue(a)) throw new Fail(a)
  return asMatrix(a!)
}

const transpose = (m: Matrix): Matrix =>
  Array.from({ length: cols(m) }, (_, c) => m.map((r) => r[c] ?? null))

/** At least one cell, or #CALC! (Excel has no empty arrays). */
const nonEmpty = (m: Matrix): Matrix => (m.length === 0 || cols(m) === 0 ? fail('#CALC!') : m)

// ---------------------------------------------------------------------------
// Matching (XLOOKUP, XMATCH)

const kind = (v: CellValue) =>
  typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 3

/** Same type and value; text without case. */
function same(a: CellValue, b: CellValue): boolean {
  if (a === null || b === null || isErrorValue(a) || isErrorValue(b)) return false
  if (kind(a) !== kind(b)) return false
  return typeof a === 'string' ? a.toLowerCase() === (b as string).toLowerCase() : a === b
}

/** Within one type: numbers, text without case, FALSE < TRUE. */
function order(a: CellValue, b: CellValue): number {
  if (typeof a === 'string') {
    const x = a.toLowerCase()
    const y = (b as string).toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  }
  const x = Number(a)
  const y = Number(b)
  return x < y ? -1 : x > y ? 1 : 0
}

function wildcard(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '~' && i + 1 < pattern.length) re += escapeRe(pattern[++i]!)
    else if (ch === '*') re += '[\\s\\S]*'
    else if (ch === '?') re += '[\\s\\S]'
    else re += escapeRe(ch)
  }
  return new RegExp(`^${re}$`, 'i')
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The 0-based position XLOOKUP/XMATCH find (-1: none). match_mode 0 exact,
 * -1 exact or next smaller, 1 exact or next larger, 2 wildcard; search_mode
 * 1 first to last, -1 last to first, 2/-2 binary over ascending/descending
 * values.
 */
export function findIndex(
  needle: CellValue,
  hay: CellValue[],
  matchMode: number,
  searchMode: number,
  fn: string,
): number {
  if (isErrorValue(needle)) throw new Fail(needle)
  if (needle === null) throw new Unsupported(`${fn} of an empty cell`)
  if (![0, -1, 1, 2].includes(matchMode)) fail('#VALUE!')
  if (![1, -1, 2, -2].includes(searchMode)) fail('#VALUE!')
  const binary = searchMode === 2 || searchMode === -2
  if (binary) {
    if (matchMode === 2) throw new Unsupported(`${fn} with wildcards in a binary search`)
    const comparable = hay.filter((v) => v !== null)
    if (comparable.some((v) => kind(v) !== kind(needle)))
      throw new Unsupported(`${fn}'s binary search over mixed types`)
    for (let i = 1; i < hay.length; i++) {
      const c = order(hay[i - 1]!, hay[i]!)
      if ((searchMode === 2 && c > 0) || (searchMode === -2 && c < 0) || hay[i] === null)
        throw new Unsupported(`${fn}'s binary search over values that are not sorted`)
    }
  }
  const idx = hay.map((_, i) => i)
  if (searchMode === -1) idx.reverse()
  if (matchMode === 2 && typeof needle === 'string') {
    const re = wildcard(needle)
    return idx.find((i) => typeof hay[i] === 'string' && re.test(hay[i] as string)) ?? -1
  }
  const exact = idx.filter((i) => same(hay[i]!, needle))
  if (binary && exact.length > 1)
    throw new Unsupported(`${fn}'s binary search over repeated values`)
  if (exact.length > 0) return exact[0]!
  if (matchMode === 0 || matchMode === 2) return -1
  let best = -1
  for (const i of idx) {
    const v = hay[i]!
    if (v === null || isErrorValue(v) || kind(v) !== kind(needle)) continue
    const c = order(v, needle)
    if (matchMode === -1 ? c >= 0 : c <= 0) continue
    if (best < 0 || (matchMode === -1 ? order(v, hay[best]!) > 0 : order(v, hay[best]!) < 0))
      best = i
  }
  if (binary && best >= 0 && hay.filter((v) => v !== null && same(v, hay[best]!)).length > 1)
    throw new Unsupported(`${fn}'s binary search over repeated values`)
  return best
}

/** A one-row or one-column array as a list (vertical when one column). */
export function vector(m: Matrix): { values: CellValue[]; vertical: boolean } | null {
  if (cols(m) === 1) return { values: m.map((r) => r[0] ?? null), vertical: true }
  if (rows(m) === 1) return { values: [...m[0]!], vertical: false }
  return null
}

export function runMatch<T>(f: () => T): T | ErrorValue {
  try {
    return f()
  } catch (e) {
    if (e instanceof Fail) return e.error
    throw e
  }
}


// ---------------------------------------------------------------------------
// Sorting (SORT, SORTBY): Microsoft's documented sort order

/** "0-9, space ! " # $ % & ( ) * , . / : ; ? @ [ \ ] ^ _ ` { | } ~ + < = > A-Z" (case ignored, ' and - ignored). */
const TEXT_ORDER = '0123456789 !"#$%&()*,./:;?@[\\]^_`{|}~+<=>abcdefghijklmnopqrstuvwxyz'
const WEIGHT = new Map([...TEXT_ORDER].map((ch, i) => [ch, i]))

function textOrder(a: string, b: string, fn: string): number {
  const strip = (s: string) => s.toLowerCase().replace(/['-]/g, '')
  const x = strip(a)
  const y = strip(b)
  for (const s of [x, y])
    for (const ch of s)
      if (!WEIGHT.has(ch))
        throw new Unsupported(`${fn} of text with “${ch}” (its order depends on the language)`)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = WEIGHT.get(x[i]!)! - WEIGHT.get(y[i]!)!
    if (d !== 0) return d
  }
  if (x.length !== y.length) return x.length - y.length
  // The same apart from hyphens/apostrophes: the one with them goes last.
  return a.length - x.length - (b.length - y.length)
}

function sortOrder(a: CellValue, b: CellValue, fn: string): number {
  if (a === null || b === null)
    throw new Unsupported(`${fn} of empty cells (Excel does not document where they go)`)
  const ka = kind(a)
  const kb = kind(b)
  if (ka !== kb) return ka - kb
  if (ka === 3) return 0
  if (ka === 1) return textOrder(a as string, b as string, fn)
  return order(a, b)
}

/** Sorts the rows of `m` by keys (row → key values), each ascending (1) or descending (-1); stable. */
function sortRows(
  m: Matrix,
  keys: Array<(r: CellValue[]) => CellValue>,
  dirs: number[],
  fn: string,
) {
  const idx = m.map((_, i) => i)
  idx.sort((i, j) => {
    for (let k = 0; k < keys.length; k++) {
      const c = sortOrder(keys[k]!(m[i]!), keys[k]!(m[j]!), fn)
      if (c !== 0) return c * dirs[k]!
    }
    return i - j
  })
  return idx.map((i) => m[i]!)
}

function direction(v: number): number {
  if (v !== 1 && v !== -1) fail('#VALUE!')
  return v
}

function listArg(a: Arg, fn: string, what: string, def: number): number[] {
  if (a === undefined) return [def]
  const m = asMatrix(a)
  return m.flat().map((v) => num(v, fn, what))
}

// ---------------------------------------------------------------------------
// The functions

type Fn = (args: Arg[]) => CellValue | Matrix

const sequenceDims = (r: number, c: number) => {
  const h = Math.trunc(r)
  const w = Math.trunc(c)
  if (h < 0 || w < 0) fail('#VALUE!')
  if (h === 0 || w === 0) fail('#CALC!')
  return [h, w] as const
}

function textSplit(args: Arg[]): CellValue | Matrix {
  const fn = 'TEXTSPLIT'
  const text = one(args[0], fn, 'text')
  if (text === undefined) fail('#VALUE!')
  if (isErrorValue(text!)) throw new Fail(text as ErrorValue)
  const s = toText(text!)
  if (isErrorValue(s)) throw new Fail(s)
  const delims = (a: Arg): string[] | null => {
    if (a === undefined) return null
    const list = asMatrix(a).flat()
    return list.map((v) => {
      if (isErrorValue(v)) throw new Fail(v)
      const t = toText(v)
      if (isErrorValue(t)) throw new Fail(t)
      if (t === '') fail('#VALUE!')
      return t
    })
  }
  const colD = delims(args[1])
  const rowD = delims(args[2])
  if (!colD && !rowD) fail('#VALUE!')
  const ignoreEmpty = bool(args[3], fn, 'ignore_empty', false)
  const mode = num(args[4], fn, 'match_mode', 0)
  if (mode !== 0 && mode !== 1) fail('#VALUE!')
  const pad: CellValue =
    args[5] === undefined ? err('#N/A') : (one(args[5], fn, 'pad_with') ?? null)
  const split = (str: string, ds: string[] | null): string[] => {
    if (!ds) return [str]
    const hay = mode === 1 ? str.toLowerCase() : str
    const needles = mode === 1 ? ds.map((d) => d.toLowerCase()) : ds
    const out: string[] = []
    let start = 0
    let i = 0
    while (i <= hay.length) {
      let hit = ''
      for (const d of needles) if (hay.startsWith(d, i) && d.length > hit.length) hit = d
      if (hit && i < hay.length) {
        out.push(str.slice(start, i))
        i += hit.length
        start = i
      } else i++
    }
    out.push(str.slice(start))
    return ignoreEmpty ? out.filter((p) => p !== '') : out
  }
  const lines = split(s, rowD)
  const grid = lines.map((l) => split(l, colD)).filter((r) => !ignoreEmpty || r.length > 0)
  if (grid.length === 0) fail('#CALC!')
  const w = Math.max(...grid.map((r) => r.length))
  return grid.map((r) => [...r, ...Array.from({ length: w - r.length }, () => pad)])
}

function sortFn(args: Arg[]): Matrix {
  const fn = 'SORT'
  const m = matrixArg(args[0])
  const byCol = bool(args[3], fn, 'by_col', false)
  const work = byCol ? transpose(m) : m
  const indexes = listArg(args[1], fn, 'sort_index', 1).map(Math.trunc)
  const orders = listArg(args[2], fn, 'sort_order', 1).map(direction)
  if (orders.length !== indexes.length && orders.length !== 1)
    throw new Unsupported('SORT with a different number of sort orders and indexes')
  for (const i of indexes) if (i < 1 || i > cols(work)) fail('#VALUE!')
  const dirs = indexes.map((_, k) => orders[orders.length === 1 ? 0 : k]!)
  const sorted = sortRows(
    work,
    indexes.map((i) => (r: CellValue[]) => r[i - 1] ?? null),
    dirs,
    fn,
  )
  return byCol ? transpose(sorted) : sorted
}

function sortBy(args: Arg[]): Matrix {
  const fn = 'SORTBY'
  const m = matrixArg(args[0])
  if (args.length < 2) fail('#VALUE!')
  const keys: CellValue[][] = []
  const dirs: number[] = []
  let vertical: boolean | null = null
  for (let k = 1; k < args.length; k += 2) {
    const by = matrixArg(args[k])
    let isVert: boolean
    if (cols(by) === 1 && rows(by) === rows(m)) isVert = true
    else if (rows(by) === 1 && cols(by) === cols(m)) isVert = false
    else return fail('#VALUE!')
    if (vertical === null) vertical = isVert
    else if (vertical !== isVert) fail('#VALUE!')
    keys.push(isVert ? by.map((r) => r[0] ?? null) : [...by[0]!])
    dirs.push(direction(num(args[k + 1], fn, 'sort_order', 1)))
  }
  const work = vertical ? m : transpose(m)
  const tagged = work.map((r, i) => [i, ...r] as CellValue[])
  const sorted = sortRows(
    tagged,
    keys.map((key) => (r: CellValue[]) => key[r[0] as number] ?? null),
    dirs,
    fn,
  ).map((r) => r.slice(1))
  return vertical ? sorted : transpose(sorted)
}

function unique(args: Arg[]): Matrix {
  const fn = 'UNIQUE'
  const m = matrixArg(args[0])
  const byCol = bool(args[1], fn, 'by_col', false)
  const once = bool(args[2], fn, 'exactly_once', false)
  const work = byCol ? transpose(m) : m
  // A blank next to a 0 or "" in the same position: Excel doesn't document whether they are one value.
  for (let c = 0; c < cols(work); c++) {
    const colVals = work.map((r) => r[c] ?? null)
    if (colVals.includes(null) && colVals.some((v) => v === 0 || v === ''))
      throw new Unsupported('UNIQUE over blanks next to 0 or empty text')
  }
  const eq = (a: CellValue[], b: CellValue[]) =>
    a.every((x, i) => {
      const y = b[i] ?? null
      if (x === null || y === null) return x === y
      if (isErrorValue(x) || isErrorValue(y))
        return isErrorValue(x) && isErrorValue(y) && x.error === y.error
      return same(x, y)
    })
  const groups: Array<{ row: CellValue[]; n: number }> = []
  for (const r of work) {
    const g = groups.find((x) => eq(x.row, r))
    if (g) g.n++
    else groups.push({ row: r, n: 1 })
  }
  const out = nonEmpty(groups.filter((g) => !once || g.n === 1).map((g) => g.row))
  return byCol ? transpose(out) : out
}

function takeDrop(args: Arg[], fn: 'TAKE' | 'DROP'): Matrix {
  const m = matrixArg(args[0])
  const r = args[1] === undefined ? null : Math.trunc(num(args[1], fn, 'rows'))
  const c = args[2] === undefined ? null : Math.trunc(num(args[2], fn, 'columns'))
  if (r === null && c === null) fail('#VALUE!')
  const cut = (n: number | null, len: number): [number, number] => {
    if (n === null) return [0, len]
    if (fn === 'TAKE') {
      if (n === 0) fail('#CALC!')
      return n > 0 ? [0, Math.min(n, len)] : [Math.max(0, len + n), len]
    }
    if (Math.abs(n) >= len) fail('#CALC!')
    return n >= 0 ? [n, len] : [0, len + n]
  }
  const [r0, r1] = cut(r, rows(m))
  const [c0, c1] = cut(c, cols(m))
  return nonEmpty(m.slice(r0, r1).map((row) => row.slice(c0, c1)))
}

function stack(args: Arg[], vertical: boolean): Matrix {
  if (args.length === 0) fail('#VALUE!')
  const parts = args.map((a) => (vertical ? matrixArg(a) : transpose(matrixArg(a))))
  const w = Math.max(...parts.map(cols))
  const out = parts.flatMap((p) =>
    p.map((r) => [...r, ...Array.from({ length: w - r.length }, () => err('#N/A'))]),
  )
  return vertical ? out : transpose(out)
}

function toLine(args: Arg[], asRow: boolean): Matrix {
  const fn = asRow ? 'TOROW' : 'TOCOL'
  const m = matrixArg(args[0])
  const ignore = Math.trunc(num(args[1], fn, 'ignore', 0))
  if (![0, 1, 2, 3].includes(ignore)) fail('#VALUE!')
  const byCol = bool(args[2], fn, 'scan_by_column', false)
  const flat = (byCol ? transpose(m) : m).flat()
  const kept = flat.filter((v) => !((ignore & 1 && v === null) || (ignore & 2 && isErrorValue(v))))
  if (kept.length === 0) fail('#CALC!')
  return asRow ? [kept] : kept.map((v) => [v])
}

function choose(args: Arg[], fn: 'CHOOSECOLS' | 'CHOOSEROWS'): Matrix {
  const m = matrixArg(args[0])
  const work = fn === 'CHOOSECOLS' ? transpose(m) : m
  if (args.length < 2) fail('#VALUE!')
  const picks = args.slice(1).flatMap((a) => asMatrix(a ?? fail('#VALUE!')).flat())
  const out = picks.map((p) => {
    const n = Math.trunc(num(p, fn, 'index'))
    if (n === 0 || Math.abs(n) > work.length) fail('#VALUE!')
    return work[n > 0 ? n - 1 : work.length + n]!
  })
  return fn === 'CHOOSECOLS' ? transpose(out) : out
}

function wrap(args: Arg[], byRows: boolean): Matrix {
  const fn = byRows ? 'WRAPROWS' : 'WRAPCOLS'
  const v = vector(matrixArg(args[0]))
  if (!v) fail('#VALUE!')
  const n = Math.trunc(num(args[1], fn, 'wrap_count'))
  if (n < 1) fail('#NUM!')
  const pad: CellValue =
    args[2] === undefined ? err('#N/A') : (one(args[2], fn, 'pad_with') ?? null)
  const out: Matrix = []
  for (let i = 0; i < v!.values.length; i += n) {
    const part = v!.values.slice(i, i + n)
    out.push([...part, ...Array.from({ length: n - part.length }, () => pad)])
  }
  return byRows ? out : transpose(out)
}

function expand(args: Arg[]): Matrix {
  const fn = 'EXPAND'
  const m = matrixArg(args[0])
  const h = args[1] === undefined ? rows(m) : Math.trunc(num(args[1], fn, 'rows'))
  const w = args[2] === undefined ? cols(m) : Math.trunc(num(args[2], fn, 'columns'))
  if (h < rows(m) || w < cols(m)) fail('#VALUE!')
  const pad: CellValue =
    args[3] === undefined ? err('#N/A') : (one(args[3], fn, 'pad_with') ?? null)
  return Array.from({ length: h }, (_, r) =>
    Array.from({ length: w }, (_, c) => (r < rows(m) && c < cols(m) ? (m[r]![c] ?? null) : pad)),
  )
}

function filter(args: Arg[]): CellValue | Matrix {
  const m = matrixArg(args[0])
  const inc = matrixArg(args[1])
  let byRows: boolean
  if (cols(inc) === 1 && rows(inc) === rows(m)) byRows = true
  else if (rows(inc) === 1 && cols(inc) === cols(m)) byRows = false
  else return fail('#VALUE!')
  const flags = (byRows ? inc.map((r) => r[0] ?? null) : inc[0]!).map((v) => {
    if (isErrorValue(v)) throw new Fail(v)
    if (typeof v === 'string') fail('#VALUE!')
    return v === null ? false : (truthy(v) as boolean)
  })
  const out = byRows ? m.filter((_, i) => flags[i]) : m.map((r) => r.filter((_, i) => flags[i]))
  if (out.length === 0 || cols(out) === 0) {
    if (args[2] !== undefined) return args[2]
    return fail('#CALC!')
  }
  return out
}

function randArray(args: Arg[]): Matrix {
  const fn = 'RANDARRAY'
  const [h, w] = sequenceDims(num(args[0], fn, 'rows', 1), num(args[1], fn, 'columns', 1))
  const lo = num(args[2], fn, 'min', 0)
  const hi = num(args[3], fn, 'max', 1)
  const integer = bool(args[4], fn, 'integer', false)
  if (lo > hi) fail('#VALUE!')
  if (integer && (!Number.isInteger(lo) || !Number.isInteger(hi))) fail('#VALUE!')
  const draw = () =>
    integer ? lo + Math.floor(Math.random() * (hi - lo + 1)) : lo + Math.random() * (hi - lo)
  return Array.from({ length: h }, () => Array.from({ length: w }, draw))
}

export const DYNAMIC: Record<string, Fn> = {
  FILTER: filter,
  SORT: sortFn,
  SORTBY: sortBy,
  UNIQUE: unique,
  SEQUENCE(args) {
    const fn = 'SEQUENCE'
    const [h, w] = sequenceDims(num(args[0], fn, 'rows'), num(args[1], fn, 'columns', 1))
    const start = num(args[2], fn, 'start', 1)
    const step = num(args[3], fn, 'step', 1)
    return Array.from({ length: h }, (_, r) =>
      Array.from({ length: w }, (_, c) => start + (r * w + c) * step),
    )
  },
  RANDARRAY: randArray,
  TAKE: (a) => takeDrop(a, 'TAKE'),
  DROP: (a) => takeDrop(a, 'DROP'),
  EXPAND: expand,
  VSTACK: (a) => stack(a, true),
  HSTACK: (a) => stack(a, false),
  TOCOL: (a) => toLine(a, false),
  TOROW: (a) => toLine(a, true),
  CHOOSECOLS: (a) => choose(a, 'CHOOSECOLS'),
  CHOOSEROWS: (a) => choose(a, 'CHOOSEROWS'),
  WRAPROWS: (a) => wrap(a, true),
  WRAPCOLS: (a) => wrap(a, false),
  TEXTSPLIT: textSplit,
  TRANSPOSE: (a) => transpose(matrixArg(a[0])),
}

/** Runs a dynamic-array function: its result, or the error that ended it. */
export function callDynamic(name: string, args: Arg[]): CellValue | Matrix {
  return runMatch(() => DYNAMIC[name]!(args))
}
