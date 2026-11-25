import { parse } from '@borgar/fx'
import { parseA1Ref } from '@borgar/fx/xlsx'
import * as F from '@formulajs/formulajs'
import { format as formatNumber } from 'numfmt'
import { callDynamic, DYNAMIC, findIndex, runMatch, vector, type Arg } from './calc-dynamic'
import { paramClass } from './calc-params'
import {
  offsetRef,
  parseIndirect,
  readTables,
  resolveStructured,
  tableAt,
  tableData,
  type At,
  type Table,
} from './calc-refs'
import {
  asMatrix,
  binary,
  cols,
  dateToSerial,
  err,
  isLambda,
  isMatrix,
  isMulti,
  isOmitted,
  isRef,
  liftN,
  rows,
  toNumber,
  truthy,
  Unsupported,
  type Env,
  type LambdaVal,
  type Matrix,
  type Rect,
  type RefVal,
  type Val,
} from './calc-values'
import { cellKey, cellName, MAX_COLS, MAX_ROWS, parseCell, rangeName, type Range } from './ref'
import { parseableTokens } from './shift'
import {
  isErrorValue,
  type CellData,
  type CellValue,
  type ErrorValue,
  type SheetInfo,
  type Workbook,
} from './workbook'
import { kid } from './xml'

export { dateToSerial, Unsupported }

/**
 * Formula evaluation for the editor (ECMA-376 Part 1 §18.17): formulas are
 * parsed by @borgar/fx (MIT) and evaluated here — references, names, tables,
 * operators with Excel's coercions — with the worksheet functions of
 * @formulajs/formulajs (MIT) and our own dynamic-array, lookup, reference
 * and LAMBDA functions (calc-dynamic.ts, calc-refs.ts).
 *
 * Three kinds of formula, as the file says: a dynamic array (Excel 365,
 * `t="array"` with XLDAPR metadata) spills its result; a legacy array
 * (Ctrl+Shift+Enter) fills its fixed range; a plain formula is read the way
 * the Excel that wrote it did — a range where a single value goes is
 * implicitly intersected with the formula's row or column.
 *
 * What this engine cannot calculate (a function neither provides, a union of
 * ranges, a circular reference without iterative calculation, an order Excel
 * doesn't document) is never guessed: the cell keeps the value Excel last
 * calculated, and the result says why (`kept`), so the editor can show it
 * and the save leaves that cached value as it was.
 */

export type Computed =
  { value: CellValue; kept: false } | { value: CellValue; kept: true; reason: string }

/** A formula evaluated on its own: an array result comes as `array` too (its top-left is `value`). */
export type Evaluated = Computed & { array?: Matrix }

/** A dynamic-array formula's spill now: its range and values; a blocked spill is the anchor alone with #SPILL!. */
export type Spill = { range: string; values: Matrix }

export type Calc = {
  /** The value of any cell: a literal as it is, a formula calculated (or kept, with why), a spilled value. */
  cell(sheet: string, row: number, col: number): Computed
  /** Evaluates a formula text as if it were typed in `sheet` (at cell `at`, like "B2"), as a dynamic-array formula. */
  evaluate(sheet: string, formula: string, at?: string): Evaluated
  /** The spill of the dynamic-array formula in this cell (null: none here, or it is kept). */
  spill(sheet: string, row: number, col: number): Spill | null
  /** The dynamic-array formulas of a sheet with the ranges they spill into now. */
  spills(sheet: string): Array<{ row: number; col: number; range: Range }>
}

type Node = { type: string; [k: string]: unknown } | null

type Ctx = {
  home: string
  at: { row: number; col: number } | null
  env: Env | null
  /** A plain formula from older Excel: ranges in single-value places are intersected. */
  legacy: boolean
  /** Inside a parameter that older Excel evaluates as an array (SUMPRODUCT …). */
  arrayCtx: boolean
  /** A legacy array formula over several cells (ROW() has no single answer). */
  multiCse: boolean
  depth: number
}

/** Functions this engine refuses rather than approximate. */
const REFUSED = new Set([
  'CELL',
  'INFO',
  'GETPIVOTDATA',
  'CUBEVALUE',
  'CUBEMEMBER',
  'CUBESET',
  'CUBERANKEDMEMBER',
  'CUBEKPIMEMBER',
  'CUBEMEMBERPROPERTY',
  'CUBESETCOUNT',
  'RTD',
  'WEBSERVICE',
  'FILTERXML',
  'IMAGE',
  'STOCKHISTORY',
  'FIELDVALUE',
])

const FJ_ERRORS = F.utils.errors as Record<string, Error>
const FJ_BY_CODE = new Map<string, Error>(Object.values(FJ_ERRORS).map((e) => [e.message, e]))
const PREFIX = /^_xlfn\.(_xlws\.)?|^_xlws\./i
const MAX_DEPTH = 200
/** Marks a BYROW/BYCOL lambda result that was an array. */
const CALC_ARRAY: ErrorValue = { error: '#CALC!' }

type ArrayResult = { kind: 'ok'; rect: Rect; m: Matrix } | { kind: 'blocked' }

export function createCalc(wb: Workbook): Calc {
  const memo = new Map<string, Computed>()
  const arrays = new Map<string, ArrayResult>()
  const asts = new Map<string, Node>()
  const sheetIndex = (name: string) => wb.findSheet(name)?.index ?? -1
  let tableCache: Table[] | null = null
  const tables = () => (tableCache ??= readTables(wb))
  const anchorCache = new Map<string, CellData[]>()

  // Iterative calculation (calcPr iterate, §18.2.2).
  const calcPr = kid(wb.pkg.xml(wb.part).documentElement!, 'calcPr')
  const iterate =
    calcPr?.getAttribute('iterate') === '1' || calcPr?.getAttribute('iterate') === 'true'
  const iterCount = Number(calcPr?.getAttribute('iterateCount') ?? 100)
  const iterDelta = Number(calcPr?.getAttribute('iterateDelta') ?? 0.001)
  const iterValues = new Map<string, CellValue>()

  // The cells being calculated (for circular references).
  type Frame = { key: string; low: number; logStart: number }
  const stack: Frame[] = []
  const onStack = new Map<string, number>()
  const tainted = new Map<string, number>()
  const memberLog: Array<{ key: string; sheet: string; row: number; col: number }> = []
  /** Spilled cells read while their possible anchor was still being calculated. */
  const skipped: Array<{ anchor: string; row: number; col: number }> = []

  const keyOf = (info: SheetInfo, row: number, col: number) => `${info.part}|${cellKey(row, col)}`

  function ast(formula: string): Node {
    const hit = asts.get(formula)
    if (hit) return hit
    let node: Node
    try {
      const toks = parseableTokens(formula).map((t) =>
        t.type === 'func'
          ? { ...t, value: t.value.replace(PREFIX, '') }
          : t.type === 'range_named'
            ? { ...t, value: t.value.replace(/^_xlpm\./i, '') }
            : t,
      )
      node = parse(toks as never) as unknown as Node
    } catch (e) {
      throw new Unsupported(
        `the formula can't be read (${e instanceof Error ? e.message : String(e)})`,
      )
    }
    asts.set(formula, node)
    return node
  }

  function arrayAnchors(sheet: string, dynamic: boolean): CellData[] {
    const k = `${dynamic ? 'd' : 'c'}|${sheet}`
    const hit = anchorCache.get(k)
    if (hit) return hit
    const list = [...wb.sheet(sheet).cells.values()].filter(
      (c) => c.formulaType === 'array' && c.dynamic === dynamic && c.formula !== null,
    )
    anchorCache.set(k, list)
    return list
  }
  const daAnchors = (sheet: string) => arrayAnchors(sheet, true)

  // ---------------------------------------------------------------------------
  // Cells

  function cell(sheet: string, row: number, col: number): Computed {
    const info = wb.findSheet(sheet)
    if (!info || info.kind !== 'worksheet') return { value: err('#REF!'), kept: false }
    const key = keyOf(info, row, col)
    const hit = memo.get(key)
    if (hit) {
      const t = tainted.get(key)
      if (t !== undefined && stack.length > 0) {
        const top = stack[stack.length - 1]!
        top.low = Math.min(top.low, t)
      }
      return hit
    }
    const data = wb.sheet(info.name).cells.get(cellKey(row, col))
    const at = onStack.get(key)
    if (at !== undefined) {
      if (!iterate)
        throw new Unsupported(`a circular reference (${info.name}!${cellName({ row, col })})`)
      const top = stack[stack.length - 1]!
      top.low = Math.min(top.low, at)
      return {
        value: iterValues.has(key) ? iterValues.get(key)! : (data?.value ?? null),
        kept: false,
      }
    }
    // No formula and no value here: maybe inside a legacy array's range or a spill.
    if (!data || (data.formula === null && (arrayOutput(info, data) || data.value === null)))
      return fromArrays(info, row, col, data)
    if (data.formulaType === 'dataTable')
      return remember(key, { value: data.value, kept: true, reason: 'a data table' })
    if (data.formula === null) return remember(key, { value: data.value, kept: false })
    return calculate(info, data, key)
  }

  function remember(key: string, c: Computed): Computed {
    memo.set(key, c)
    return c
  }

  /** Runs a formula cell's calculation on the stack (circular references, iteration). */
  function calculate(info: SheetInfo, data: CellData, key: string): Computed {
    const frame: Frame = { key, low: Infinity, logStart: memberLog.length }
    const index = stack.length
    const run = (): Computed => {
      stack.push(frame)
      onStack.set(key, index)
      try {
        return { value: formulaValue(info, data, key), kept: false }
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e
        return { value: data.value, kept: true, reason: e.message }
      } finally {
        stack.pop()
        onStack.delete(key)
      }
    }
    let out = run()
    if (frame.low < index) {
      // Part of a cycle that an outer cell closes: settled there.
      memo.set(key, out)
      tainted.set(key, frame.low)
      memberLog.push({ key, sheet: info.name, row: data.row, col: data.col })
      const parent = stack[stack.length - 1]
      if (parent) parent.low = Math.min(parent.low, frame.low)
      return out
    }
    if (frame.low === index) out = iterateCycle(info, data, key, frame, run, out)
    return remember(key, out)
  }

  function iterateCycle(
    info: SheetInfo,
    data: CellData,
    key: string,
    frame: Frame,
    run: () => Computed,
    first: Computed,
  ): Computed {
    let out = first
    let members = memberLog.splice(frame.logStart)
    const cachedOf = (k: string, sheet: string, row: number, col: number) =>
      k === key ? data.value : (wb.sheet(sheet).cells.get(cellKey(row, col))?.value ?? null)
    const all = () => [...members, { key, sheet: info.name, row: data.row, col: data.col }]
    const valueOf = (k: string) => (k === key ? out : memo.get(k)!)
    let prev = new Map(
      all().map((m) => [m.key, iterValues.get(m.key) ?? cachedOf(m.key, m.sheet, m.row, m.col)]),
    )
    const keepAll = (reason: string): Computed => {
      for (const m of all()) {
        tainted.delete(m.key)
        if (m.key !== key)
          memo.set(m.key, { value: cachedOf(m.key, m.sheet, m.row, m.col), kept: true, reason })
      }
      return { value: data.value, kept: true, reason }
    }
    for (let n = 1; ; n++) {
      const keptOne = all()
        .map((m) => valueOf(m.key))
        .find((c) => c.kept)
      if (keptOne?.kept) return keepAll(keptOne.reason)
      let change = 0
      for (const m of all())
        change = Math.max(change, distance(prev.get(m.key) ?? null, valueOf(m.key).value))
      if (change < iterDelta) {
        for (const m of all()) {
          tainted.delete(m.key)
          iterValues.delete(m.key)
        }
        return out
      }
      if (n >= iterCount)
        return keepAll(`a circular reference that does not settle in ${iterCount} iterations`)
      prev = new Map(all().map((m) => [m.key, valueOf(m.key).value]))
      for (const [k, v] of prev) iterValues.set(k, v)
      for (const m of members) {
        memo.delete(m.key)
        arrays.delete(m.key)
        tainted.delete(m.key)
      }
      arrays.delete(key)
      frame.low = Infinity
      frame.logStart = memberLog.length
      out = run()
      members = memberLog.splice(frame.logStart)
    }
  }

  /** A plain, legacy-array or dynamic-array formula cell's value (throws Unsupported). */
  function formulaValue(info: SheetInfo, data: CellData, key: string): CellValue {
    const node = ast(data.formula!)
    const at = { row: data.row, col: data.col }
    if (data.formulaType !== 'array') {
      const ctx: Ctx = {
        home: info.name,
        at,
        env: null,
        legacy: true,
        arrayCtx: false,
        multiCse: false,
        depth: 0,
      }
      const v = single(evalNode(node, ctx), ctx)
      return v === null ? 0 : v
    }
    const range = data.formulaRef ?? {
      top: data.row,
      left: data.col,
      bottom: data.row,
      right: data.col,
    }
    const multiCse = !data.dynamic && isMulti(range)
    const ctx: Ctx = {
      home: info.name,
      at,
      env: null,
      legacy: false,
      arrayCtx: true,
      multiCse,
      depth: 0,
    }
    const m = zeroBlanks(toMatrix(evalNode(node, ctx)))
    if (!data.dynamic) {
      const h = range.bottom - range.top + 1
      const w = range.right - range.left + 1
      const fitted: Matrix = Array.from({ length: h }, (_, r) =>
        Array.from({ length: w }, (_, c) => {
          const rr = rows(m) === 1 ? 0 : r
          const cc = cols(m) === 1 ? 0 : c
          return rr < rows(m) && cc < cols(m) ? (m[rr]![cc] ?? 0) : err('#N/A')
        }),
      )
      arrays.set(key, { kind: 'ok', rect: range, m: fitted })
      return fitted[0]![0]!
    }
    const rect = {
      top: data.row,
      left: data.col,
      bottom: data.row + rows(m) - 1,
      right: data.col + cols(m) - 1,
    }
    if (blocked(info, data, rect)) {
      arrays.set(key, { kind: 'blocked' })
      checkSkipped(key, rect, info, true)
      return err('#SPILL!')
    }
    arrays.set(key, { kind: 'ok', rect, m })
    checkSkipped(key, rect, info, false)
    return m[0]![0]!
  }

  /** A spill that covers a cell read while the spill was being calculated is circular. */
  function checkSkipped(anchor: string, rect: Rect, info: SheetInfo, isBlocked: boolean) {
    for (let i = skipped.length - 1; i >= 0; i--) {
      const s = skipped[i]!
      if (s.anchor !== anchor) continue
      skipped.splice(i, 1)
      if (
        !isBlocked &&
        s.row >= rect.top &&
        s.row <= rect.bottom &&
        s.col >= rect.left &&
        s.col <= rect.right
      )
        throw new Unsupported(
          `a circular reference (the spill of ${info.name}!${cellName({ row: rect.top, col: rect.left })})`,
        )
    }
  }

  /** Whether a spill into `rect` is blocked: a value or formula there, merged cells, the sheet's edge, a table. */
  function blocked(info: SheetInfo, anchor: CellData, rect: Rect): boolean {
    if (rect.bottom >= MAX_ROWS || rect.right >= MAX_COLS) return true
    if (!isMulti(rect)) return false
    const sheet = wb.sheet(info.name)
    const own = anchor.formulaRef
    const inside = (c: { row: number; col: number }) =>
      c.row >= rect.top && c.row <= rect.bottom && c.col >= rect.left && c.col <= rect.right
    for (const c of sheet.cells.values()) {
      if (!inside(c) || (c.row === anchor.row && c.col === anchor.col)) continue
      if (c.formula !== null) return true
      if (c.value === null) continue
      const spillOutput =
        arrayOutput(info, c) && (sameRange(c.inArrayOf, own) || isDynamicAnchor(info, c.inArrayOf!))
      if (!spillOutput) return true
    }
    if (sheet.merges.some((m) => overlaps(m, rect))) return true
    if (tableAt(tables(), { sheet: info.name, row: anchor.row, col: anchor.col })) return true
    return false
  }

  /**
   * A cell holding an array formula's result: in a legacy array's range, or
   * in a dynamic array's last spill (unless that spill was blocked: then the
   * range is the anchor's intended one and its values are the blockers).
   */
  function arrayOutput(info: SheetInfo, d: CellData): boolean {
    if (!d.inArrayOf) return false
    const anchor = wb.sheet(info.name).cells.get(cellKey(d.inArrayOf.top, d.inArrayOf.left))
    if (!anchor?.dynamic) return true
    return !(isErrorValue(anchor.value) && anchor.value.error === '#SPILL!')
  }

  const isDynamicAnchor = (info: SheetInfo, r: Range) =>
    wb.sheet(info.name).cells.get(cellKey(r.top, r.left))?.dynamic === true

  /** A cell without its own formula: inside a legacy array's range, or maybe in a spill. */
  function fromArrays(
    info: SheetInfo,
    row: number,
    col: number,
    data: CellData | undefined,
  ): Computed {
    const key = keyOf(info, row, col)
    const cseRange =
      data?.inArrayOf && arrayOutput(info, data) && !isDynamicAnchor(info, data.inArrayOf)
        ? data.inArrayOf
        : (arrayAnchors(info.name, false).find(
            (a) =>
              a.formulaRef &&
              row >= a.formulaRef.top &&
              row <= a.formulaRef.bottom &&
              col >= a.formulaRef.left &&
              col <= a.formulaRef.right,
          )?.formulaRef ?? null)
    if (cseRange) {
      const r = cseRange
      const anchor = cell(info.name, r.top, r.left)
      const cached = data?.value ?? null
      if (anchor.kept) return remember(key, { value: cached, kept: true, reason: anchor.reason })
      const res = arrays.get(keyOf(info, r.top, r.left))
      if (res?.kind !== 'ok') return remember(key, { value: cached, kept: false })
      return remember(key, { value: res.m[row - r.top]?.[col - r.left] ?? null, kept: false })
    }
    const covering: Computed[] = []
    let uncertain = false
    for (const a of daAnchors(info.name)) {
      if (a.row > row || a.col > col || (a.row === row && a.col === col)) continue
      const akey = keyOf(info, a.row, a.col)
      if (onStack.has(akey)) {
        skipped.push({ anchor: akey, row, col })
        uncertain = true
        continue
      }
      const c = cell(info.name, a.row, a.col)
      if (c.kept) {
        const r = a.formulaRef
        if (r && row >= r.top && row <= r.bottom && col >= r.left && col <= r.right)
          covering.push({ value: data?.value ?? null, kept: true, reason: c.reason })
        continue
      }
      const res = arrays.get(akey)
      if (res?.kind !== 'ok') continue
      const { rect, m } = res
      if (row >= rect.top && row <= rect.bottom && col >= rect.left && col <= rect.right)
        covering.push({ value: m[row - rect.top]![col - rect.left] ?? 0, kept: false })
    }
    let out: Computed
    if (covering.length === 0) out = { value: null, kept: false }
    else if (covering.length === 1) out = covering[0]!
    else out = { value: data?.value ?? null, kept: true, reason: 'overlapping spill ranges' }
    return uncertain ? out : remember(key, out)
  }

  /** A referenced cell's value; a referenced formula that can't be calculated makes this one unsupported too. */
  function refCell(sheet: string, row: number, col: number): CellValue {
    const c = cell(sheet, row, col)
    if (c.kept) {
      const info = wb.findSheet(sheet)!
      const data = wb.sheet(info.name).cells.get(cellKey(row, col))
      // Data-table results are what Excel calculated: usable as they are.
      if (data && (data.formulaType === 'dataTable' || isDataTableMember(info, data)))
        return c.value
      throw new Unsupported(c.reason)
    }
    return c.value
  }

  const isDataTableMember = (info: SheetInfo, d: CellData) =>
    !!d.inArrayOf &&
    wb.sheet(info.name).cells.get(cellKey(d.inArrayOf.top, d.inArrayOf.left))?.formulaType ===
      'dataTable'

  // ---------------------------------------------------------------------------
  // Values

  function materialize(v: RefVal): CellValue | Matrix {
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

  /** A value for an operator or single-value parameter: older Excel intersects a range with the formula's cell. */
  function operand(v: Val, ctx: Ctx): CellValue | Matrix {
    if (isLambda(v)) return err('#CALC!')
    if (isOmitted(v)) return null
    if (!isRef(v)) return v
    if (ctx.legacy && !ctx.arrayCtx && isMulti(v.ref)) return intersect(v, ctx)
    return materialize(v)
  }

  /** A whole value (a range or array taken as it is). */
  function whole(v: Val): CellValue | Matrix {
    if (isLambda(v)) return err('#CALC!')
    if (isOmitted(v)) return null
    return isRef(v) ? materialize(v) : v
  }

  /** Implicit intersection: the cell of a one-row/one-column range on the formula's row or column. */
  function intersect(v: RefVal, ctx: Ctx): CellValue {
    if (!ctx.at) throw new Unsupported('implicit intersection without a cell')
    const { sheet, top, left, bottom, right } = v.ref
    const r = top === bottom ? top : ctx.at.row >= top && ctx.at.row <= bottom ? ctx.at.row : -1
    const c = left === right ? left : ctx.at.col >= left && ctx.at.col <= right ? ctx.at.col : -1
    if (r < 0 || c < 0) return err('#VALUE!')
    return refCell(sheet, r, c)
  }

  /** The @ operator (and how a single-cell formula ends): a range intersected, an array's top-left value. */
  function single(v: Val, ctx: Ctx): CellValue {
    if (isLambda(v)) return err('#CALC!')
    if (isOmitted(v)) return null
    if (isRef(v)) return isMulti(v.ref) ? intersect(v, ctx) : (materialize(v) as CellValue)
    if (isMatrix(v)) return v[0]?.[0] ?? null
    return v
  }

  function toMatrix(v: Val): Matrix {
    if (isLambda(v)) return [[err('#CALC!')]]
    if (isOmitted(v)) return [[null]]
    return asMatrix(isRef(v) ? materialize(v) : v)
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
        }
      | undefined
    if (!ref?.range) throw new Unsupported(`the reference ${text}`)
    if (ref.workbookName) throw new Unsupported('a reference to another workbook')
    const r = ref.range
    return clipped(ref.sheetName || home, r.top, r.left, r.bottom, r.right)
  }

  /** A rectangle on a sheet; whole rows/columns end at the sheet's used extent. */
  function clipped(
    sheetName: string,
    top: number | null,
    left: number | null,
    bottom: number | null,
    right: number | null,
  ): RefVal | ErrorValue {
    const info = wb.findSheet(sheetName)
    if (!info || info.kind !== 'worksheet') return err('#REF!')
    const data = wb.sheet(info.name)
    const t = top ?? 0
    const l = left ?? 0
    return {
      ref: {
        sheet: info.name,
        top: t,
        left: l,
        bottom: bottom ?? Math.max(t, data.maxRow),
        right: right ?? Math.max(l, data.maxCol),
      },
    }
  }

  function lookupEnv(env: Env | null, name: string): Val | undefined {
    const k = name.toLowerCase()
    for (let e = env; e; e = e.parent) if (e.names.has(k)) return e.names.get(k)
    return undefined
  }

  function definedName(name: string, ctx: Ctx, sheet?: string | null): Val | undefined {
    const names = wb.definedNames()
    const k = name.toLowerCase()
    const home = sheet ?? ctx.home
    const local = names.find((n) => n.name.toLowerCase() === k && n.localSheet === sheetIndex(home))
    const global = names.find((n) => n.name.toLowerCase() === k && n.localSheet === null)
    const def = local ?? global
    if (!def) return undefined
    if (ctx.depth > MAX_DEPTH) throw new Unsupported(`the name ${name} refers to itself`)
    return evalNode(ast(def.formula), { ...ctx, env: null, depth: ctx.depth + 1 })
  }

  function nameValue(name: string, ctx: Ctx): Val {
    const bound = lookupEnv(ctx.env, name)
    if (bound !== undefined) return bound
    const def = definedName(name, ctx)
    if (def !== undefined) return def
    const k = name.toLowerCase()
    const t = tables().find((x) => x.name.toLowerCase() === k)
    if (t) return tableData(t)
    return err('#NAME?')
  }

  const fullAt = (ctx: Ctx): At | null => (ctx.at ? { sheet: ctx.home, ...ctx.at } : null)

  function evalNode(node: Node, ctx: Ctx): Val {
    if (node === null) return { omitted: true }
    switch (node.type) {
      case 'Literal':
        return node.value as number | string | boolean
      case 'ErrorLiteral':
        return err(String(node.value))
      case 'ReferenceIdentifier': {
        const kind = node.kind as string
        if (kind === 'name') return nameValue(String(node.value), ctx)
        if (kind === 'table') return resolveStructured(String(node.value), tables(), fullAt(ctx))
        return resolveRef(String(node.value), ctx.home)
      }
      case 'UnaryExpression': {
        const [arg] = node.arguments as Node[]
        const op = node.operator as string
        const v = evalNode(arg!, ctx)
        if (op === '#') return anchorArray(v)
        if (op === '@') return single(v, ctx)
        return liftN([operand(v, ctx)], ([a]) => {
          const n = toNumber(a!)
          if (isErrorValue(n)) return n
          return op === '-' ? -n : op === '%' ? n / 100 : n
        })
      }
      case 'BinaryExpression': {
        const op = node.operator as string
        const [l, r] = node.arguments as Node[]
        if (op === ',') throw new Unsupported('range unions')
        if (op === ':' || op === ' ') {
          const a = evalNode(l!, ctx)
          const b = evalNode(r!, ctx)
          if (isErrorValue(a)) return a
          if (isErrorValue(b)) return b
          if (!isRef(a) || !isRef(b)) return err('#VALUE!')
          if (a.ref.sheet !== b.ref.sheet) return err('#VALUE!')
          const x = a.ref
          const y = b.ref
          if (op === ':')
            return {
              ref: {
                sheet: x.sheet,
                top: Math.min(x.top, y.top),
                left: Math.min(x.left, y.left),
                bottom: Math.max(x.bottom, y.bottom),
                right: Math.max(x.right, y.right),
              },
            }
          const rect = {
            top: Math.max(x.top, y.top),
            left: Math.max(x.left, y.left),
            bottom: Math.min(x.bottom, y.bottom),
            right: Math.min(x.right, y.right),
          }
          if (rect.top > rect.bottom || rect.left > rect.right) return err('#NULL!')
          return { ref: { sheet: x.sheet, ...rect } }
        }
        const a = operand(evalNode(l!, ctx), ctx)
        const b = operand(evalNode(r!, ctx), ctx)
        return liftN([a, b], ([x, y]) => binary(op, x!, y!))
      }
      case 'CallExpression':
        return call(node, ctx)
      case 'ArrayExpression':
        return (node.elements as Node[][]).map((row) =>
          row.map((el) => single(evalNode(el, ctx), ctx)),
        )
      case 'LambdaExpression':
        return {
          lambda: {
            params: (node.params as Array<{ name: string }>).map((p) => p.name.toLowerCase()),
            body: node.body,
            env: ctx.env,
            home: ctx.home,
          },
        }
      case 'LetExpression': {
        const names = new Map<string, Val>()
        const env: Env = { names, parent: ctx.env }
        const inner = { ...ctx, env }
        for (const d of node.declarations as Array<{ id: { name: string }; init: Node }>)
          names.set(d.id.name.toLowerCase(), evalNode(d.init, inner))
        return evalNode(node.body as Node, inner)
      }
      default:
        throw new Unsupported(`a ${node.type}`)
    }
  }

  function anchorArray(v: Val): Val {
    if (isErrorValue(v)) return v
    if (!isRef(v)) return err('#REF!')
    const info = wb.findSheet(v.ref.sheet)!
    const data = wb.sheet(info.name).cells.get(cellKey(v.ref.top, v.ref.left))
    if (!data?.dynamic) return err('#REF!')
    const c = cell(info.name, v.ref.top, v.ref.left)
    if (c.kept) throw new Unsupported(c.reason)
    const res = arrays.get(keyOf(info, v.ref.top, v.ref.left))
    if (res?.kind !== 'ok') return err('#REF!')
    return { ref: { sheet: info.name, ...res.rect } }
  }

  function invoke(fn: LambdaVal, args: Val[], ctx: Ctx): Val {
    const { params, body, env, home } = fn.lambda
    if (args.length !== params.length || body === null) return err('#VALUE!')
    if (ctx.depth > MAX_DEPTH) throw new Unsupported('a LAMBDA that calls itself too deeply')
    const names = new Map<string, Val>(params.map((p, i) => [p, args[i]!]))
    return evalNode(body as Node, {
      ...ctx,
      home,
      env: { names, parent: env },
      depth: ctx.depth + 1,
    })
  }

  /** A lambda's result where one value goes (MAP, SCAN, BYROW …). */
  function oneResult(v: Val, fn: string): CellValue {
    const m = whole(v)
    if (!isMatrix(m)) return m
    if (rows(m) === 1 && cols(m) === 1) return m[0]![0]!
    if (fn === 'BYROW' || fn === 'BYCOL') return CALC_ARRAY
    if (fn === 'SCAN' || fn === 'MAKEARRAY') return err('#CALC!')
    throw new Unsupported(`${fn} with a LAMBDA that returns an array`)
  }

  function scalarArg(node: Node, ctx: Ctx, fn: string): CellValue {
    const v = operand(evalNode(node, ctx), ctx)
    if (!isMatrix(v)) return v
    if (rows(v) === 1 && cols(v) === 1) return v[0]![0]!
    throw new Unsupported(`${fn} with an array where one value goes`)
  }

  function numArg(node: Node | undefined, ctx: Ctx, fn: string, def: number): number | ErrorValue {
    if (node === undefined || node === null) return def
    const v = scalarArg(node, ctx, fn)
    return toNumber(v)
  }

  function call(node: { [k: string]: unknown }, ctx: Ctx): Val {
    const args = node.arguments as Node[]
    const callee = node.callee as { type: string; name?: string }
    if (callee.type !== 'Identifier') {
      const f = evalNode(callee as Node, ctx)
      if (!isLambda(f)) return isErrorValue(f) ? f : err('#VALUE!')
      return invoke(
        f,
        args.map((a) => evalNode(a, ctx)),
        ctx,
      )
    }
    const name = (callee.name ?? '').toUpperCase().replace(PREFIX, '')
    const bound = lookupEnv(ctx.env, name)
    if (bound !== undefined) {
      if (!isLambda(bound)) return err('#VALUE!')
      return invoke(
        bound,
        args.map((a) => evalNode(a, ctx)),
        ctx,
      )
    }
    const arg = (i: number): Val =>
      args[i] !== undefined ? evalNode(args[i]!, ctx) : { omitted: true }
    switch (name) {
      case 'IF': {
        const c = operand(arg(0), ctx)
        const branch = (i: number, dflt: CellValue): Val =>
          args.length > i ? (args[i] === null ? 0 : arg(i)) : dflt
        if (isMatrix(c)) {
          const t = whole(branch(1, true))
          const f = whole(branch(2, false))
          return liftN([c, t, f], ([x, y, z]) => {
            if (isErrorValue(x!)) return x!
            const b = truthy(x!)
            return isErrorValue(b) ? b : b ? y! : z!
          })
        }
        if (isErrorValue(c)) return c
        const t = truthy(c)
        if (isErrorValue(t)) return t
        return t ? branch(1, true) : branch(2, false)
      }
      case 'IFERROR':
      case 'IFNA': {
        const v = operand(arg(0), ctx)
        const bad = (x: CellValue) => isErrorValue(x) && (name === 'IFERROR' || x.error === '#N/A')
        if (isMatrix(v)) return liftN([v, whole(arg(1))], ([x, a]) => (bad(x!) ? a! : x!))
        return bad(v) ? arg(1) : v
      }
      case 'CHOOSE': {
        const i = toNumber(scalarArg(args[0]!, ctx, name))
        if (isErrorValue(i)) return i
        const n = Math.trunc(i)
        if (n < 1 || n >= args.length) return err('#VALUE!')
        return arg(n)
      }
      case 'ISOMITTED': {
        const v = arg(0)
        return isOmitted(v)
      }
      case 'SINGLE':
        return single(arg(0), ctx)
      case 'ANCHORARRAY':
        return anchorArray(arg(0))
      case 'ROW':
      case 'COLUMN': {
        if (args.length === 0 || args[0] === null) {
          if (!ctx.at) throw new Unsupported(`${name}() without the formula's cell`)
          if (ctx.multiCse)
            throw new Unsupported(`${name}() in an array formula over several cells`)
          return (name === 'ROW' ? ctx.at.row : ctx.at.col) + 1
        }
        const r = arg(0)
        if (isErrorValue(r)) return r
        if (!isRef(r)) return err('#VALUE!')
        const { top, left, bottom, right } = r.ref
        if (ctx.legacy && !ctx.arrayCtx) return (name === 'ROW' ? top : left) + 1
        if (name === 'ROW')
          return top === bottom
            ? top + 1
            : Array.from({ length: bottom - top + 1 }, (_, i) => [top + i + 1])
        return left === right
          ? left + 1
          : [Array.from({ length: right - left + 1 }, (_, i) => left + i + 1)]
      }
      case 'ROWS':
      case 'COLUMNS': {
        const r = arg(0)
        if (isRef(r))
          return name === 'ROWS' ? r.ref.bottom - r.ref.top + 1 : r.ref.right - r.ref.left + 1
        const m = whole(r)
        if (isErrorValue(m)) return m
        return isMatrix(m) ? (name === 'ROWS' ? rows(m) : cols(m)) : 1
      }
      case 'ISREF': {
        const v = args[0] ? evalNode(args[0], ctx) : null
        return isRef(v)
      }
      case 'OFFSET': {
        const base = arg(0)
        if (isErrorValue(base)) return base
        if (!isRef(base)) return err('#VALUE!')
        const nums = [1, 2, 3, 4].map((i) =>
          args[i] === undefined || args[i] === null ? null : numArg(args[i], ctx, name, 0),
        )
        for (const n of nums) if (n !== null && isErrorValue(n)) return n
        return offsetRef(
          base,
          (nums[0] as number | null) ?? 0,
          (nums[1] as number | null) ?? 0,
          nums[2] as number | null,
          nums[3] as number | null,
        )
      }
      case 'INDIRECT': {
        const text = scalarArg(args[0]!, ctx, name)
        if (isErrorValue(text)) return text
        const a1v = args[1] === undefined || args[1] === null ? true : scalarArg(args[1], ctx, name)
        if (isErrorValue(a1v)) return a1v
        const a1 = truthy(a1v)
        if (isErrorValue(a1)) return a1
        const target = parseIndirect(String(text ?? ''), a1, fullAt(ctx))
        if (isErrorValue(target)) return target
        if (target.kind === 'table') return resolveStructured(target.text, tables(), fullAt(ctx))
        if (target.kind === 'name') {
          const v = definedName(target.name, ctx, target.sheet)
          return v !== undefined && isRef(v) ? v : err('#REF!')
        }
        const { rect, whole: w } = target
        return clipped(
          target.sheet ?? ctx.home,
          w.cols ? null : rect.top,
          w.rows ? null : rect.left,
          w.cols ? null : rect.bottom,
          w.rows ? null : rect.right,
        )
      }
      case 'INDEX':
        return index(args, ctx)
      case 'XLOOKUP':
        return xlookup(args, ctx)
      case 'XMATCH': {
        const needle = operand(arg(0), ctx)
        const hay = whole(arg(1))
        const v = vector(asMatrix(hay))
        if (isErrorValue(hay)) return hay
        if (!v) return err('#VALUE!')
        const mode = numArg(args[2], ctx, name, 0)
        const search = numArg(args[3], ctx, name, 1)
        if (isErrorValue(mode)) return mode
        if (isErrorValue(search)) return search
        return liftN([needle], ([x]) =>
          runMatch(() => {
            const i = findIndex(x!, v.values, mode, search, name)
            return i < 0 ? err('#N/A') : i + 1
          }),
        )
      }
      case 'MAP': {
        const f = arg(args.length - 1)
        if (!isLambda(f)) return err('#VALUE!')
        const inputs = args.slice(0, -1).map((a) => asMatrix(whole(evalNode(a, ctx))))
        if (inputs.length === 0) return err('#VALUE!')
        const h = rows(inputs[0]!)
        const w = cols(inputs[0]!)
        if (inputs.some((m) => rows(m) !== h || cols(m) !== w))
          throw new Unsupported('MAP over arrays of different sizes')
        return Array.from({ length: h }, (_, r) =>
          Array.from({ length: w }, (_, c) =>
            oneResult(
              invoke(
                f,
                inputs.map((m) => m[r]![c] ?? null),
                ctx,
              ),
              name,
            ),
          ),
        )
      }
      case 'REDUCE':
      case 'SCAN': {
        const f = arg(2)
        if (!isLambda(f)) return err('#VALUE!')
        const init = args[0] === null || args[0] === undefined ? 0 : whole(arg(0))
        const m = asMatrix(whole(arg(1)))
        let acc: Val = init
        const out: Matrix = []
        for (const row of m) {
          const line: CellValue[] = []
          for (const x of row) {
            acc = invoke(f, [isRef(acc) ? whole(acc) : acc, x], ctx)
            if (name === 'SCAN') line.push(oneResult(acc, name))
          }
          out.push(line)
        }
        return name === 'SCAN' ? out : acc
      }
      case 'BYROW':
      case 'BYCOL': {
        const f = arg(1)
        if (!isLambda(f)) return err('#VALUE!')
        const m = asMatrix(whole(arg(0)))
        const out =
          name === 'BYROW'
            ? m.map((r) => [oneResult(invoke(f, [[r]], ctx), name)])
            : [
                Array.from({ length: cols(m) }, (_, c) =>
                  oneResult(invoke(f, [m.map((r) => [r[c] ?? null])], ctx), name),
                ),
              ]
        // A LAMBDA that returns an array per row/column: the result is #CALC!.
        return out.flat().some((v) => v === CALC_ARRAY) ? err('#CALC!') : out
      }
      case 'MAKEARRAY': {
        const f = arg(2)
        if (!isLambda(f)) return err('#VALUE!')
        const h = numArg(args[0], ctx, name, 0)
        const w = numArg(args[1], ctx, name, 0)
        if (isErrorValue(h)) return h
        if (isErrorValue(w)) return w
        if (Math.trunc(h) < 1 || Math.trunc(w) < 1) return err('#VALUE!')
        return Array.from({ length: Math.trunc(h) }, (_, r) =>
          Array.from({ length: Math.trunc(w) }, (_, c) =>
            oneResult(invoke(f, [r + 1, c + 1], ctx), name),
          ),
        )
      }
    }
    if (DYNAMIC[name]) {
      const values: Arg[] = args.map((a) => {
        if (a === null) return undefined
        const v = evalNode(a, { ...ctx, arrayCtx: true })
        return isOmitted(v) ? undefined : whole(v)
      })
      return callDynamic(name, values)
    }
    if (LOCAL[name]) return generic(name, args, ctx, LOCAL[name]!)
    const named = definedName(name, ctx)
    if (named !== undefined) {
      if (!isLambda(named)) return err('#NAME?')
      return invoke(
        named,
        args.map((a) => evalNode(a, ctx)),
        ctx,
      )
    }
    if (REFUSED.has(name)) throw new Unsupported(name)
    const fn = lookupFunction(name)
    if (!fn) throw new Unsupported(name)
    return generic(name, args, ctx, (...xs) => {
      let out: unknown
      try {
        out = fn(...xs.map(toFormulaJs))
      } catch (e) {
        throw new Unsupported(`${name} (${e instanceof Error ? e.message : String(e)})`)
      }
      return fromFormulaJs(out, name)
    })
  }

  /**
   * A worksheet function: single-value parameters lift over arrays (and, in
   * older Excel's single-cell formulas, intersect ranges); range parameters
   * take the range whole.
   */
  function generic(
    name: string,
    args: Node[],
    ctx: Ctx,
    f: (...xs: Array<CellValue | Matrix>) => CellValue | Matrix,
  ): CellValue | Matrix {
    const classes = args.map((_, i) => paramClass(name, i))
    const values = args.map((a, i) => {
      const cls = classes[i]!
      const sub = cls === 'array' && !ctx.arrayCtx ? { ...ctx, arrayCtx: true } : ctx
      const v = evalNode(a, sub)
      return cls === 'value' ? operand(v, sub) : whole(v)
    })
    const lifted = values.map((v, i) => classes[i] === 'value' && isMatrix(v))
    if (!lifted.some(Boolean)) return f(...values)
    const liftArgs = values.filter((_, i) => lifted[i]) as Matrix[]
    return liftN(liftArgs, (xs) => {
      let k = 0
      const call = values.map((v, i) => (lifted[i] ? xs[k++]! : v))
      const out = f(...call)
      return isMatrix(out) ? (out[0]?.[0] ?? null) : out
    })
  }

  function index(args: Node[], ctx: Ctx): Val {
    const base = evalNode(args[0] ?? null, ctx.legacy ? { ...ctx, arrayCtx: true } : ctx)
    if (isErrorValue(base)) return base
    if (args[3] !== undefined && args[3] !== null) {
      const area = numArg(args[3], ctx, 'INDEX', 1)
      if (isErrorValue(area)) return area
      if (Math.trunc(area) !== 1) throw new Unsupported('INDEX over several areas')
    }
    const h = isRef(base) ? base.ref.bottom - base.ref.top + 1 : rows(asMatrix(whole(base)))
    const w = isRef(base) ? base.ref.right - base.ref.left + 1 : cols(asMatrix(whole(base)))
    const rArg = numArg(args[1], ctx, 'INDEX', 0)
    if (isErrorValue(rArg)) return rArg
    const hasCol = args[2] !== undefined && args[2] !== null
    const cArg = hasCol ? numArg(args[2], ctx, 'INDEX', 0) : 0
    if (isErrorValue(cArg)) return cArg
    let r = Math.trunc(rArg)
    let c = Math.trunc(cArg)
    // One row: the single number picks a column.
    if (!hasCol && h === 1 && w > 1) {
      c = r
      r = 0
    }
    if (r < 0 || c < 0) return err('#VALUE!')
    if (r > h || c > w) return err('#REF!')
    const top = r === 0 ? 0 : r - 1
    const bottom = r === 0 ? h - 1 : r - 1
    const left = c === 0 ? 0 : c - 1
    const right = c === 0 ? w - 1 : c - 1
    if (isRef(base)) {
      const b = base.ref
      return {
        ref: {
          sheet: b.sheet,
          top: b.top + top,
          left: b.left + left,
          bottom: b.top + bottom,
          right: b.left + right,
        },
      }
    }
    const m = asMatrix(whole(base))
    const out = m.slice(top, bottom + 1).map((row) => row.slice(left, right + 1))
    return rows(out) === 1 && cols(out) === 1 ? out[0]![0]! : out
  }

  function xlookup(args: Node[], ctx: Ctx): Val {
    const name = 'XLOOKUP'
    if (args.length < 3) return err('#VALUE!')
    const needle = operand(evalNode(args[0]!, ctx), ctx)
    const hayV = evalNode(args[1]!, ctx)
    const retV = evalNode(args[2]!, ctx)
    if (isErrorValue(hayV)) return hayV
    if (isErrorValue(retV)) return retV
    const hay = vector(asMatrix(whole(hayV)))
    if (!hay) return err('#VALUE!')
    const ret = isRef(retV) ? null : asMatrix(whole(retV))
    const retRows = isRef(retV) ? retV.ref.bottom - retV.ref.top + 1 : rows(ret!)
    const retCols = isRef(retV) ? retV.ref.right - retV.ref.left + 1 : cols(ret!)
    const n = hay.values.length
    const vertical = hay.vertical
    if (vertical ? retRows !== n : retCols !== n) return err('#VALUE!')
    const mode = numArg(args[4], ctx, name, 0)
    const search = numArg(args[5], ctx, name, 1)
    if (isErrorValue(mode)) return mode
    if (isErrorValue(search)) return search
    const notFound = (): Val =>
      args[3] !== undefined && args[3] !== null ? evalNode(args[3], ctx) : err('#N/A')
    const pick = (i: number): Val => {
      if (isRef(retV)) {
        const b = retV.ref
        return vertical
          ? { ref: { ...b, top: b.top + i, bottom: b.top + i } }
          : { ref: { ...b, left: b.left + i, right: b.left + i } }
      }
      const out = vertical ? [ret![i]!] : ret!.map((r) => [r[i] ?? null])
      return rows(out) === 1 && cols(out) === 1 ? out[0]![0]! : out
    }
    if (!isMatrix(needle)) {
      const i = runMatch(() => findIndex(needle, hay.values, mode, search, name))
      if (isErrorValue(i)) return i
      return i < 0 ? notFound() : pick(i)
    }
    if (vertical ? retCols !== 1 : retRows !== 1)
      throw new Unsupported('XLOOKUP of several values returning several columns')
    return liftN([needle], ([x]) => {
      const i = runMatch(() => findIndex(x!, hay.values, mode, search, name))
      if (isErrorValue(i)) return i
      return single(i < 0 ? notFound() : pick(i), ctx)
    })
  }

  // ---------------------------------------------------------------------------

  function spillOf(sheet: string, row: number, col: number): Spill | null {
    const info = wb.findSheet(sheet)
    if (!info || info.kind !== 'worksheet') return null
    const data = wb.sheet(info.name).cells.get(cellKey(row, col))
    if (!data?.dynamic || data.formulaType !== 'array') return null
    const c = cell(info.name, row, col)
    if (c.kept) return null
    const res = arrays.get(keyOf(info, row, col))
    if (!res) return null
    if (res.kind === 'blocked') return { range: cellName({ row, col }), values: [[err('#SPILL!')]] }
    return { range: rangeName(res.rect), values: res.m }
  }

  return {
    cell,
    spill: spillOf,
    spills(sheet) {
      const info = wb.findSheet(sheet)
      if (!info || info.kind !== 'worksheet') return []
      return daAnchors(info.name).flatMap((a) => {
        const s = spillOf(info.name, a.row, a.col)
        if (!s) return []
        const res = arrays.get(keyOf(info, a.row, a.col))
        const range =
          res?.kind === 'ok' ? res.rect : { top: a.row, left: a.col, bottom: a.row, right: a.col }
        return [{ row: a.row, col: a.col, range }]
      })
    },
    evaluate(sheet, formula, atText) {
      const addr = atText ? parseCell(atText) : null
      if (atText && !addr) throw new Error(`xlsx calc: “${atText}” is not a cell address`)
      try {
        const ctx: Ctx = {
          home: sheet,
          at: addr,
          env: null,
          legacy: false,
          arrayCtx: true,
          multiCse: false,
          depth: 0,
        }
        const m = zeroBlanks(toMatrix(evalNode(ast(formula), ctx)))
        const value = m[0]![0]!
        if (rows(m) === 1 && cols(m) === 1) return { value, kept: false }
        return { value, kept: false, array: m }
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e
        return { value: null, kept: true, reason: e.message }
      }
    },
  }
}

/** Blank cells in an array result show as 0 (Excel). */
const zeroBlanks = (m: Matrix): Matrix => m.map((r) => r.map((v) => (v === null ? 0 : v)))

const sameRange = (a: Range | null, b: Range | null) =>
  !!a && !!b && a.top === b.top && a.left === b.left && a.bottom === b.bottom && a.right === b.right
const overlaps = (a: Rect, b: Rect) =>
  a.top <= b.bottom && b.top <= a.bottom && a.left <= b.right && b.left <= a.right

/** Scalar worksheet functions of our own (their parameters lift over arrays). */
const LOCAL: Record<string, (...xs: Array<CellValue | Matrix>) => CellValue> = {
  ISBLANK: (v) => v === null,
  TEXT: (v, code) => {
    if (isErrorValue(v)) return v as ErrorValue
    if (isErrorValue(code)) return code as ErrorValue
    try {
      return formatNumber(String(code ?? ''), (v as CellValue) ?? 0, { locale: 'en', throws: true })
    } catch {
      return err('#VALUE!')
    }
  },
  HYPERLINK: (link, friendly) =>
    (friendly === undefined || friendly === null ? link : friendly) as CellValue,
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

function fromFormulaJs(out: unknown, name: string): CellValue | Matrix {
  if (out instanceof Error) return err(out.message.startsWith('#') ? out.message : '#VALUE!')
  if (out instanceof Date) return dateToSerial(out)
  if (typeof out === 'number') return Number.isFinite(out) ? out : err('#NUM!')
  if (typeof out === 'string' || typeof out === 'boolean') return out
  if (out === null) return null
  if (Array.isArray(out)) {
    const grid = (Array.isArray(out[0]) ? out : [out]) as unknown[][]
    return grid.map((row) =>
      row.map((x) => {
        const v = fromFormulaJs(x, name)
        return isMatrix(v) ? (v[0]?.[0] ?? null) : v
      }),
    )
  }
  throw new Unsupported(`${name} (no result)`)
}

function distance(a: CellValue, b: CellValue): number {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b)
  if (a === b) return 0
  if (isErrorValue(a) && isErrorValue(b) && a.error === b.error) return 0
  return Infinity
}
