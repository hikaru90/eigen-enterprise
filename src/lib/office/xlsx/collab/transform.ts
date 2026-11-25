import type { SheetOp } from '../ops'
import { cellName, MAX_COLS, MAX_ROWS, parseCell, parseRange, rangeName, type Range } from '../ref'
import { deleteEdit, insertEdit, renameSheetRefs, rewriteRefs, type RefEdit } from '../shift'

/**
 * Concurrent sheet operations, made to fit after each other (operational
 * transformation over the SheetOp union; plan/phase-office-files.md §7.4).
 *
 * `transform(a, b)` is `a` rewritten to apply after `b`, when both were made
 * on the same state: a cell write below an inserted row moves down, a write
 * into a deleted row or onto a deleted sheet goes, a formula's references
 * follow the moved cells, an edit on a renamed sheet names its new name.
 * It returns the operations that stand for `a` afterwards — none (it no
 * longer has anything to act on), one, or two (a row deletion an insertion
 * split in two).
 *
 * The rule, so new operations sync without per-op code:
 *
 * 1. Every operation names its coordinates in COORDS — which fields are the
 *    sheet, a cell, a range, a row/column index, an insertion boundary
 *    (`insert_at`), a span, a frozen edge, a formula. The record is keyed
 *    by every `op` of the union, so a new operation without an entry does
 *    not compile. Its coordinates then move with insertions/deletions/
 *    renames by the generic rules below.
 * 2. An operation that itself moves or renames things says what in EFFECTS
 *    (shift rows/columns, rename a sheet, remove a sheet); everything else
 *    is `null` (it changes contents in place, last writer wins by the
 *    server's order). An operation that moves cells some other way (cut and
 *    paste, sorting) must get its own effect kind here before it can shift
 *    other people's pending edits — until then its effect is `null` and a
 *    concurrent edit keeps its coordinates, as with sort today.
 * 3. An operation name the union does not have is never guessed at: the
 *    server refuses it (`SHEET_OP_NAMES`, the submit schema), and
 *    `transform` throws on one.
 *
 * Generic rules: a cell/index at or after an insertion moves by its count;
 * one inside a deletion is deleted (its array element goes; a top-level
 * one drops the whole operation), one after moves back. An `insert_at`
 * boundary inside a deletion clamps to the start of the deleted block so
 * the inserted rows/columns still land where the block was. A range or
 * span grows when the insertion falls inside it and shrinks when part of
 * it is deleted (all of it: the operation goes). A frozen edge
 * (rows/columns kept on screen) moves when rows above it come or go.
 */

export type Axis = 'row' | 'col'

export type Coord =
  /** The sheet the operation's other coordinates are on (by name). */
  | { kind: 'sheet'; path: string }
  /** A cell address ("B3"). */
  | { kind: 'cell'; path: string }
  /** A cell range ("A1:C9"); null stays null. */
  | { kind: 'range'; path: string }
  /** A row or column index from 0. */
  | { kind: 'index'; axis: Axis; path: string }
  /** An insertion boundary before row/column `at` from 0 (clamps rather than drops inside a deletion). */
  | { kind: 'insert_at'; axis: Axis; path: string }
  /** Indices `from`…`to` (inclusive) of one axis. */
  | { kind: 'span'; axis: Axis; from: string; to: string }
  /** A count of rows/columns from the top/left (frozen panes). */
  | { kind: 'edge'; axis: Axis; path: string }
  /** A formula as typed, written on the operation's sheet. */
  | { kind: 'formula'; path: string }

export type Effect =
  | { kind: 'shift'; sheet: string; axis: Axis; at: number; count: number; insert: boolean }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'remove_sheet'; sheet: string }

type OpName = SheetOp['op']
/** The member(s) of the union whose `op` can be K (insert/delete rows/columns share one member). */
type OpOf<K extends OpName> = SheetOp extends infer U ? (U extends { op: infer O } ? (K extends O ? U : never) : never) : never

const sheet = (path = 'sheet'): Coord => ({ kind: 'sheet', path })

/** Where each operation's coordinates are (rule 1). */
export const COORDS: { [K in OpName]: Coord[] } = {
  set_cells: [sheet(), { kind: 'cell', path: 'cells[].ref' }, { kind: 'formula', path: 'cells[].formula' }],
  set_format: [sheet(), { kind: 'range', path: 'range' }],
  add_sheet: [],
  rename_sheet: [sheet()],
  delete_sheet: [sheet()],
  insert_rows: [sheet(), { kind: 'insert_at', axis: 'row', path: 'at' }],
  delete_rows: [sheet()],
  insert_columns: [sheet(), { kind: 'insert_at', axis: 'col', path: 'at' }],
  delete_columns: [sheet()],
  set_style: [sheet(), { kind: 'range', path: 'range' }],
  set_column_width: [sheet(), { kind: 'span', axis: 'col', from: 'from', to: 'to' }],
  set_row_height: [sheet(), { kind: 'span', axis: 'row', from: 'from', to: 'to' }],
  sort_range: [sheet(), { kind: 'range', path: 'range' }, { kind: 'index', axis: 'col', path: 'keys[].col' }],
  set_autofilter: [sheet(), { kind: 'range', path: 'range' }],
  filter_column: [sheet(), { kind: 'index', axis: 'col', path: 'col' }],
  freeze_panes: [sheet(), { kind: 'edge', axis: 'row', path: 'rows' }, { kind: 'edge', axis: 'col', path: 'cols' }],
}

/** Insert/delete rows/columns: one member of the union whose `op` names which. */
type MoveOp = OpOf<'insert_rows'>

const move = (op: MoveOp): Effect => ({
  kind: 'shift',
  sheet: op.sheet,
  axis: op.op.endsWith('rows') ? 'row' : 'col',
  at: op.at,
  count: op.count,
  insert: op.op.startsWith('insert'),
})

/** What each operation moves or renames (rule 2). */
export const EFFECTS: { [K in OpName]: (op: OpOf<K>) => Effect | null } = {
  set_cells: () => null,
  set_format: () => null,
  add_sheet: () => null,
  rename_sheet: (op) => ({ kind: 'rename', from: op.sheet, to: op.name }),
  delete_sheet: (op) => ({ kind: 'remove_sheet', sheet: op.sheet }),
  insert_rows: move,
  delete_rows: move,
  insert_columns: move,
  delete_columns: move,
  set_style: () => null,
  set_column_width: () => null,
  set_row_height: () => null,
  sort_range: () => null,
  set_autofilter: () => null,
  filter_column: () => null,
  freeze_panes: () => null,
}

export function effectOf(op: SheetOp): Effect | null {
  // EFFECTS is keyed by every op of the union (a new op without an entry does not compile).
  const fn = (EFFECTS as unknown as Record<string, ((o: SheetOp) => Effect | null) | undefined>)[op.op]
  if (!fn) throw new Error(`xlsx collab: “${String(op.op)}” is not a sheet operation.`)
  return fn(op)
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

// ---------------------------------------------------------------------------
// Moving one coordinate

/** An index past a shift: the new index, or null (deleted). */
function shiftIndex(i: number, e: Extract<Effect, { kind: 'shift' }>): number | null {
  if (e.insert) return i >= e.at ? i + e.count : i
  if (i < e.at) return i
  if (i >= e.at + e.count) return i - e.count
  return null
}

/** An insertion boundary past a shift: clamps into a deleted block instead of dropping. */
function shiftInsertAt(at: number, e: Extract<Effect, { kind: 'shift' }>): number {
  if (e.insert) return at >= e.at ? at + e.count : at
  if (at <= e.at) return at
  if (at >= e.at + e.count) return at - e.count
  return e.at
}

/** A span past a shift (null: all of it deleted). */
function shiftSpan(lo: number, hi: number, e: Extract<Effect, { kind: 'shift' }>, limit: number): [number, number] | null {
  if (e.insert) {
    if (hi < e.at) return [lo, hi]
    const nlo = lo >= e.at ? lo + e.count : lo
    const nhi = Math.min(hi + e.count, limit - 1)
    return nlo > nhi ? null : [nlo, nhi]
  }
  const end = e.at + e.count - 1
  if (hi < e.at) return [lo, hi]
  if (lo > end) return [lo - e.count, hi - e.count]
  if (lo >= e.at && hi <= end) return null
  return [lo < e.at ? lo : e.at, hi > end ? hi - e.count : e.at - 1]
}

function shiftEdge(n: number, e: Extract<Effect, { kind: 'shift' }>): number {
  if (e.insert) return e.at < n ? n + e.count : n
  if (n <= e.at) return n
  return n - Math.min(e.count, n - e.at)
}

const limitOf = (axis: Axis) => (axis === 'row' ? MAX_ROWS : MAX_COLS)

function shiftRange(r: Range, e: Extract<Effect, { kind: 'shift' }>): Range | null {
  const [lo, hi] = e.axis === 'row' ? (['top', 'bottom'] as const) : (['left', 'right'] as const)
  const s = shiftSpan(r[lo], r[hi], e, limitOf(e.axis))
  return s ? { ...r, [lo]: s[0], [hi]: s[1] } : null
}

function refEditOf(e: Extract<Effect, { kind: 'shift' }>): RefEdit {
  return e.insert ? insertEdit(e.sheet, e.axis, e.at, e.count) : deleteEdit(e.sheet, e.axis, e.at, e.count)
}

/** A formula past an effect, as typed (a leading "=" kept). */
function moveFormula(text: string, home: string, e: Effect): string {
  const eq = text.startsWith('=')
  const body = eq ? text.slice(1) : text
  let out: string
  try {
    if (e.kind === 'shift') out = rewriteRefs(body, home, refEditOf(e))
    else if (e.kind === 'rename') out = renameSheetRefs(body, e.from, e.to)
    else return text
  } catch {
    // A formula that can't be tokenized is refused when it is applied; it moves as it is.
    return text
  }
  return eq ? `=${out}` : out
}

// ---------------------------------------------------------------------------
// Walking an operation's coordinates

type Obj = Record<string, unknown>

/** The value at `path` ("a" or "list[].a") of each target: the containers and keys. */
function splitPath(path: string): { list: string | null; key: string } {
  const i = path.indexOf('[].')
  return i < 0 ? { list: null, key: path } : { list: path.slice(0, i), key: path.slice(i + 3) }
}

const DROP = Symbol('drop')
type Mapper = (value: unknown) => unknown | typeof DROP

/**
 * Maps the value at `path`: `DROP` for a top-level value drops the
 * operation (returns false); for an array element it drops the element,
 * and an array left empty drops the operation.
 */
function mapPath(op: Obj, path: string, fn: Mapper): boolean {
  const { list, key } = splitPath(path)
  if (list === null) {
    if (!(key in op) || op[key] === undefined) return true
    const v = fn(op[key])
    if (v === DROP) return false
    op[key] = v
    return true
  }
  const items = op[list]
  if (!Array.isArray(items)) return true
  if (items.length === 0) return true
  const kept: unknown[] = []
  for (const item of items as Obj[]) {
    if (!(key in item) || item[key] === undefined) {
      kept.push(item)
      continue
    }
    const v = fn(item[key])
    if (v === DROP) continue
    kept.push({ ...item, [key]: v })
  }
  op[list] = kept
  return kept.length > 0
}

/** Every operation name of the union (what the server accepts). */
export const SHEET_OP_NAMES = Object.keys(COORDS) as OpName[]

function coordsOf(op: SheetOp): Coord[] {
  const known = (COORDS as Record<string, Coord[] | undefined>)[op.op]
  if (!known) throw new Error(`xlsx collab: “${String(op.op)}” is not a sheet operation.`)
  return known
}

/** `op` (a copy) with its coordinates moved past `e`; null when it has nothing left to act on. */
function moveCoords(op: SheetOp, e: Effect): SheetOp | null {
  const out = structuredClone(op) as SheetOp & Obj
  const coords = coordsOf(op)
  const sheetCoord = coords.find((c) => c.kind === 'sheet')
  const home = sheetCoord ? (out[sheetCoord.path] as string | undefined) : undefined

  if (e.kind === 'remove_sheet') {
    if (home !== undefined && same(home, e.sheet)) return null
    return out
  }
  if (e.kind === 'rename') {
    for (const c of coords) {
      if (c.kind === 'sheet' && typeof out[c.path] === 'string' && same(out[c.path] as string, e.from)) out[c.path] = e.to
      if (c.kind === 'formula' && home !== undefined)
        mapPath(out, c.path, (v) => (typeof v === 'string' ? moveFormula(v, home, e) : v))
    }
    return out
  }
  // A shift: only what is on its sheet moves, except formulas (they may point into it).
  const onSheet = home !== undefined && same(home, e.sheet)
  const lo = e.axis === 'row' ? 'row' : 'col'
  for (const c of coords) {
    let ok = true
    switch (c.kind) {
      case 'sheet':
        break
      case 'cell':
        if (!onSheet) break
        ok = mapPath(out, c.path, (v) => {
          const a = typeof v === 'string' ? parseCell(v) : null
          if (!a) return v
          const i = shiftIndex(a[lo], e)
          if (i === null) return DROP
          if (i >= limitOf(e.axis)) return DROP
          return cellName(lo === 'row' ? { row: i, col: a.col } : { row: a.row, col: i })
        })
        break
      case 'range':
        if (!onSheet) break
        ok = mapPath(out, c.path, (v) => {
          const r = typeof v === 'string' ? parseRange(v) : null
          if (!r) return v
          const n = shiftRange(r, e)
          return n ? rangeName(n) : DROP
        })
        break
      case 'index':
        if (!onSheet || c.axis !== e.axis) break
        ok = mapPath(out, c.path, (v) => {
          if (typeof v !== 'number') return v
          const i = shiftIndex(v, e)
          return i === null || i >= limitOf(e.axis) ? DROP : i
        })
        break
      case 'insert_at':
        if (!onSheet || c.axis !== e.axis) break
        mapPath(out, c.path, (v) => (typeof v === 'number' ? shiftInsertAt(v, e) : v))
        break
      case 'span': {
        if (!onSheet || c.axis !== e.axis) break
        const from = out[c.from]
        const to = out[c.to]
        if (typeof from !== 'number' || typeof to !== 'number') break
        const s = shiftSpan(Math.min(from, to), Math.max(from, to), e, limitOf(e.axis))
        if (!s) ok = false
        else {
          out[c.from] = s[0]
          out[c.to] = s[1]
        }
        break
      }
      case 'edge':
        if (!onSheet || c.axis !== e.axis) break
        mapPath(out, c.path, (v) => (typeof v === 'number' ? shiftEdge(v, e) : v))
        break
      case 'formula':
        if (home === undefined) break
        mapPath(out, c.path, (v) => (typeof v === 'string' ? moveFormula(v, home, e) : v))
        break
    }
    if (!ok) return null
  }
  return out
}

// ---------------------------------------------------------------------------
// Transforming

const isDelete = (op: SheetOp): op is MoveOp =>
  op.op === 'delete_rows' || op.op === 'delete_columns'

/** A deletion past a shift on its own axis and sheet: the rows it still deletes, as they are numbered afterwards. */
function moveDeletion(op: MoveOp, e: Extract<Effect, { kind: 'shift' }>): SheetOp[] {
  const s = op.at
  const n = op.count
  if (e.insert) {
    if (e.at <= s) return [{ ...op, at: s + e.count }]
    if (e.at >= s + n) return [op]
    // Inserted inside: the new rows stay; the deletion goes around them.
    return [
      { ...op, at: s, count: e.at - s },
      { ...op, at: s + e.count, count: s + n - e.at },
    ]
  }
  const t = e.at
  const m = e.count
  const overlap = Math.max(0, Math.min(s + n, t + m) - Math.max(s, t))
  const count = n - overlap
  if (count === 0) return []
  const at = s < t ? s : s >= t + m ? s - m : t
  return [{ ...op, at, count }]
}

/** `a` rewritten to apply after `b` (both made on the same state). */
export function transform(a: SheetOp, b: SheetOp): SheetOp[] {
  const e = effectOf(b)
  if (!e) return [a]
  if (e.kind === 'shift' && isDelete(a)) {
    const axis = a.op.endsWith('rows') ? 'row' : 'col'
    if (same(a.sheet, e.sheet) && axis === e.axis) return moveDeletion(a, e)
    return [a]
  }
  const out = moveCoords(a, e)
  return out ? [out] : []
}

/**
 * Two lists made on the same state, each rewritten to apply after the
 * other: `[as', bs']` with as' = as after bs and bs' = bs after as. The
 * same grid of single transforms whichever way it is walked, so the server
 * (a whole batch against what it already has) and a client (its pending
 * changes against each new remote one) compute the same operations.
 */
export function transformLists<T>(as: T[], bs: T[], one: (a: T, b: T) => T[]): [T[], T[]] {
  if (as.length === 0 || bs.length === 0) return [as, bs]
  if (as.length === 1 && bs.length === 1) return [one(as[0]!, bs[0]!), one(bs[0]!, as[0]!)]
  if (as.length > 1) {
    const [a1, b1] = transformLists([as[0]!], bs, one)
    const [rest, b2] = transformLists(as.slice(1), b1, one)
    return [[...a1, ...rest], b2]
  }
  const [a1, b1] = transformLists(as, [bs[0]!], one)
  const [a2, rest] = transformLists(a1, bs.slice(1), one)
  return [a2, [...b1, ...rest]]
}
