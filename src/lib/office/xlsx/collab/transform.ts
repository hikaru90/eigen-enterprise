import type { SheetOp } from '../ops'
import { cellName, MAX_COLS, MAX_ROWS, parseCell, parseRange, rangeName, type Range } from '../ref'
import { deleteEdit, insertEdit, renameSheetRefs, rewriteRefs, type RefEdit, type RefRange } from '../shift'

/**
 * Concurrent sheet operations, made to fit after each other (operational
 * transformation over the SheetOp union; plan/phase-office-files.md §7.9).
 *
 * `transform(a, b)` is `a` rewritten to apply after `b`, when both were made
 * on the same state: a cell write below an inserted row moves down, a write
 * into a deleted row or onto a deleted sheet goes, a formula's references
 * follow the moved cells, an edit on a renamed sheet names its new name, an
 * edit inside a block someone cut and pasted elsewhere goes along with it.
 * It returns the operations that stand for `a` afterwards — none (nothing
 * left for it to act on), one, or two (a row deletion an insertion split) —
 * or throws `TransformRefusal` with the reason when `a` can't be made to fit
 * correctly (never a guess): the change is then not made, and its author is
 * told why.
 *
 * The rule, so new operations sync without per-op code:
 *
 * 1. Every operation names its coordinates in COORDS — which fields are its
 *    sheet, other sheets it names, cells, ranges, row/column indices,
 *    insertion points, spans, frozen edges, formulas and references, chart
 *    anchors, pixel positions, rule priorities, a cut's source block. The
 *    record is keyed by every `op` of the union, so a new operation without
 *    an entry does not compile; with one, it follows moves, renames and
 *    deletions by the generic rules below.
 * 2. What an operation does to *other* operations' coordinates is in EFFECTS
 *    (also keyed by the union): shifting rows/columns, renaming or removing a
 *    sheet, moving a block (cut and paste), reordering rows (sort),
 *    rewriting a block (merge, PivotTables, deleting a table with its cells),
 *    resizing tables (typing, pasting or filling next to one), renumbering
 *    conditional formats. Contents changed in place: no effect (the later
 *    change in the server's order wins).
 * 3. An operation that moves cells in a new way needs a new effect kind
 *    here. Until it has one, its EFFECTS entry must be a refusing kind
 *    (`rewrite` over what it touches), never `null`.
 * 4. Operation names outside the union are refused (`SHEET_OP_NAMES`, the
 *    submit schema), and `transform` throws on one.
 *
 * Generic rules: a cell/index at or after an insertion moves by its count;
 * one inside a deletion is deleted (its array element goes; a top-level one
 * drops the whole operation), one after moves back. An insertion point
 * inside a deletion lands where the block was. A range or span grows when
 * the insertion falls inside it and shrinks when part of it is deleted (all
 * of it: the operation goes). A frozen edge moves when rows above it come or
 * go. A chart anchor marker moves with its cell (into a deleted block: to
 * where the block was). Formulas and references (chart series, names, print
 * areas, rule formulas) are rewritten as Excel rewrites them.
 *
 * Refused, by name: anything placed in sheet pixels (pictures, shapes)
 * when rows or columns of its sheet came or went (where it lands depends on
 * row heights, which a transform does not know); a cut whose source rows or
 * columns moved; coordinates partly inside a block that was cut and pasted,
 * or inside a range that was sorted, merged or rewritten by a PivotTable;
 * a table's explicit new range after its sheet's tables may have grown; a
 * conditional format addressed by priority after the sheet's rules were
 * renumbered.
 */

export type Axis = 'row' | 'col'

export type Coord =
  /** The sheet the operation's other coordinates are on (by name). */
  | { kind: 'sheet'; path: string }
  /** Another sheet the operation names (a scope, a source or target sheet); null stays null. */
  | { kind: 'sheet_ref'; path: string }
  /** A cell address ("B3"), on the operation's sheet or on the sheet at `on`. */
  | { kind: 'cell'; path: string; on?: string }
  /** A cell range ("A1:C9", "Sheet2!A1:C9"); null stays null. On the operation's sheet or `on`. */
  | { kind: 'range'; path: string; on?: string }
  /** A row or column index from 0. */
  | { kind: 'index'; axis: Axis; path: string }
  /** An insertion boundary before row/column `at` from 0 (lands where a deleted block was). */
  | { kind: 'insert_at'; axis: Axis; path: string }
  /** Indices `from`…`to` (inclusive) of one axis. */
  | { kind: 'span'; axis: Axis; from: string; to: string }
  /** A count of rows/columns from the top/left (frozen panes). */
  | { kind: 'edge'; axis: Axis; path: string }
  /** A formula or reference text (with or without "="), written on the operation's sheet (or none: `home: false`). */
  | { kind: 'formula'; path: string; home?: false }
  /** A chart anchor: a range text, or { from, to } cell markers. */
  | { kind: 'anchor'; path: string }
  /** A position in sheet pixels (a picture, a shape): refused when rows or columns of the sheet move. */
  | { kind: 'pixels'; path: string }
  /** A conditional format addressed by its priority: refused after the sheet's rules were renumbered. */
  | { kind: 'cf_priority'; path: string }
  /** A table's new range, set explicitly: refused after the sheet's tables may have grown. */
  | { kind: 'table_ref'; path: string }
  /** A cut's source block (the clip's sheet, origin and size). */
  | { kind: 'cut_source'; path: string }

export type Shift = { kind: 'shift'; sheet: string; axis: Axis; at: number; count: number; insert: boolean }
export type Effect =
  | Shift
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'remove_sheet'; sheet: string }
  /** Cut and paste: the block `from` on `fromSheet` now starts at `to` on `toSheet`. */
  | { kind: 'move_block'; fromSheet: string; from: Range; toSheet: string; to: { row: number; col: number } }
  /** Rows of `range` were reordered (a sort): what lay in them is somewhere else in it now. */
  | { kind: 'reorder'; sheet: string; range: Range; why: string }
  /** The cells of `range` (null: unknown, anywhere on the sheet) were rewritten as a block. */
  | { kind: 'rewrite'; sheet: string; range: Range | null; why: string }
  /** Tables on the sheet may have grown (typing, pasting, filling next to one). */
  | { kind: 'tables_resized'; sheet: string }
  /** The sheet's conditional formats were renumbered (added, deleted, moved, cleared). */
  | { kind: 'cf_renumbered'; sheet: string }

/** A change that can't be made to fit after another one: why (said to its author). */
export class TransformRefusal extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'TransformRefusal'
  }
}

type OpName = SheetOp['op']
/** The member(s) of the union whose `op` can be K (insert/delete rows/columns share one member). */
type OpOf<K extends OpName> = SheetOp extends infer U ? (U extends { op: infer O } ? (K extends O ? U : never) : never) : never

const sheet = (path = 'sheet'): Coord => ({ kind: 'sheet', path })
const range = (path = 'range', on?: string): Coord => (on ? { kind: 'range', path, on } : { kind: 'range', path })
const cell = (path = 'ref', on?: string): Coord => (on ? { kind: 'cell', path, on } : { kind: 'cell', path })
const span = (axis: Axis): Coord => ({ kind: 'span', axis, from: 'from', to: 'to' })
const formula = (path: string): Coord => ({ kind: 'formula', path })
const series = (list: string): Coord[] => [
  formula(`${list}[].values`),
  formula(`${list}[].categories`),
  formula(`${list}[].sizes`),
  formula(`${list}[].name.ref`),
]

/** Where each operation's coordinates are (rule 1). */
export const COORDS: { [K in OpName]: Coord[] } = {
  set_cells: [sheet(), cell('cells[].ref'), formula('cells[].formula')],
  set_format: [sheet(), range()],
  add_sheet: [],
  rename_sheet: [sheet()],
  delete_sheet: [sheet()],
  insert_rows: [sheet(), { kind: 'insert_at', axis: 'row', path: 'at' }],
  delete_rows: [sheet()],
  insert_columns: [sheet(), { kind: 'insert_at', axis: 'col', path: 'at' }],
  delete_columns: [sheet()],
  set_style: [sheet(), range()],
  set_column_width: [sheet(), span('col')],
  set_row_height: [sheet(), span('row')],
  sort_range: [sheet(), range(), { kind: 'index', axis: 'col', path: 'keys[].col' }],
  set_autofilter: [sheet(), range()],
  filter_column: [sheet(), { kind: 'index', axis: 'col', path: 'col' }],
  freeze_panes: [sheet(), { kind: 'edge', axis: 'row', path: 'rows' }, { kind: 'edge', axis: 'col', path: 'cols' }],
  // Pictures, shapes, notes, threaded comments
  insert_picture: [sheet(), { kind: 'pixels', path: 'x' }],
  insert_shape: [sheet(), { kind: 'pixels', path: 'x' }],
  update_drawing: [sheet(), { kind: 'pixels', path: 'box' }],
  delete_drawing: [sheet()],
  set_note: [sheet(), cell()],
  delete_note: [sheet(), cell()],
  add_comment: [sheet(), cell()],
  reply_comment: [sheet()],
  edit_comment: [sheet()],
  resolve_comment: [sheet()],
  delete_comment: [sheet()],
  // Conditional formats, validation, links, names, protection
  cf_add: [sheet(), range(), formula('rule.formula1'), formula('rule.formula2')],
  cf_update: [sheet(), { kind: 'cf_priority', path: 'priority' }, range(), formula('rule.formula1'), formula('rule.formula2')],
  cf_delete: [sheet(), { kind: 'cf_priority', path: 'priority' }],
  cf_clear: [sheet(), range()],
  cf_move: [sheet(), { kind: 'cf_priority', path: 'priority' }],
  validation_set: [sheet(), range(), formula('rule.formula1'), formula('rule.formula2')],
  validation_clear: [sheet(), range()],
  hyperlink_set: [sheet(), range()],
  hyperlink_remove: [sheet(), range()],
  name_add: [{ kind: 'sheet_ref', path: 'scope' }, { kind: 'formula', path: 'refersTo', home: false }],
  name_update: [{ kind: 'sheet_ref', path: 'scope' }, { kind: 'formula', path: 'refersTo', home: false }],
  name_delete: [{ kind: 'sheet_ref', path: 'scope' }],
  protect_sheet: [sheet()],
  unprotect_sheet: [sheet()],
  protect_workbook: [],
  unprotect_workbook: [],
  set_cell_protection: [sheet(), range()],
  // Excel tables, PivotTables
  create_table: [sheet(), range()],
  update_table: [sheet(), { kind: 'table_ref', path: 'ref' }],
  delete_table: [sheet()],
  create_pivot: [
    { kind: 'sheet_ref', path: 'sourceSheet' },
    range('source', 'sourceSheet'),
    { kind: 'sheet_ref', path: 'targetSheet' },
    cell('targetCell', 'targetSheet'),
  ],
  update_pivot: [sheet()],
  refresh_pivot: [sheet()],
  delete_pivot: [sheet()],
  // Charts
  chart_create: [sheet(), range(), ...series('series'), { kind: 'anchor', path: 'at' }],
  chart_update: [sheet(), ...series('series')],
  chart_move: [sheet(), { kind: 'anchor', path: 'to' }],
  chart_delete: [sheet()],
  // Everyday editing
  paste: [sheet(), range('at'), { kind: 'cut_source', path: 'clip' }],
  fill: [sheet(), range('source'), range('target')],
  replace: [{ kind: 'sheet_ref', path: 'sheet' }, { kind: 'sheet_ref', path: 'cells[].sheet' }, cell('cells[].ref', 'cells[].sheet')],
  merge_cells: [sheet(), range()],
  clear_range: [sheet(), range()],
  set_rich_text: [sheet(), cell()],
  shift_decimals: [sheet(), range()],
  hide_columns: [sheet(), span('col')],
  hide_rows: [sheet(), span('row')],
  group_columns: [sheet(), span('col')],
  ungroup_columns: [sheet(), span('col')],
  group_rows: [sheet(), span('row')],
  ungroup_rows: [sheet(), span('row')],
  collapse_columns: [sheet(), span('col')],
  collapse_rows: [sheet(), span('row')],
  set_outline_level: [sheet()],
  autofit_columns: [sheet(), span('col')],
  autofit_rows: [sheet(), span('row')],
  move_sheet: [sheet()],
  set_sheet_color: [sheet()],
  set_sheet_visibility: [sheet()],
  duplicate_sheet: [sheet()],
  set_page_setup: [sheet(), formula('printArea'), formula('repeatRows'), formula('repeatCols')],
  set_view_options: [sheet()],
  // A batch transforms its operations one by one (`transform`), never through COORDS.
  batch: [],
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

const none = (): Effect[] => []
const tablesGrow = (op: { sheet: string }): Effect[] => [{ kind: 'tables_resized', sheet: op.sheet }]
const cfRenumber = (op: { sheet: string }): Effect[] => [{ kind: 'cf_renumbered', sheet: op.sheet }]
const pivotRewrite = (op: { sheet: string; pivot: string }): Effect[] => [
  { kind: 'rewrite', sheet: op.sheet, range: null, why: `the PivotTable ${op.pivot} on ${op.sheet} was rewritten` },
]

function pasteEffects(op: OpOf<'paste'>): Effect[] {
  const out: Effect[] = [{ kind: 'tables_resized', sheet: op.sheet }]
  const clip = op.clip
  const at = parseRange(op.at)
  if (op.cut && clip.sheet && at) {
    out.push({
      kind: 'move_block',
      fromSheet: clip.sheet,
      from: {
        top: clip.origin.row,
        left: clip.origin.col,
        bottom: clip.origin.row + clip.rows - 1,
        right: clip.origin.col + clip.cols - 1,
      },
      toSheet: op.sheet,
      to: { row: at.top, col: at.left },
    })
  }
  return out
}

/** What each operation does to others' coordinates (rule 2). */
export const EFFECTS: { [K in OpName]: (op: OpOf<K>) => Effect[] } = {
  set_cells: tablesGrow,
  set_format: none,
  add_sheet: none,
  rename_sheet: (op) => [{ kind: 'rename', from: op.sheet, to: op.name }],
  delete_sheet: (op) => [{ kind: 'remove_sheet', sheet: op.sheet }],
  insert_rows: (op) => [move(op)],
  delete_rows: (op) => [move(op)],
  insert_columns: (op) => [move(op)],
  delete_columns: (op) => [move(op)],
  set_style: none,
  set_column_width: none,
  set_row_height: none,
  sort_range: (op) => {
    const r = parseRange(op.range)
    return r ? [{ kind: 'reorder', sheet: op.sheet, range: r, why: `${op.sheet}!${op.range} was sorted` }] : []
  },
  set_autofilter: none,
  filter_column: none,
  freeze_panes: none,
  insert_picture: none,
  insert_shape: none,
  update_drawing: none,
  delete_drawing: none,
  set_note: none,
  delete_note: none,
  add_comment: none,
  reply_comment: none,
  edit_comment: none,
  resolve_comment: none,
  delete_comment: none,
  cf_add: cfRenumber,
  cf_update: none,
  cf_delete: cfRenumber,
  cf_clear: cfRenumber,
  cf_move: cfRenumber,
  validation_set: none,
  validation_clear: none,
  hyperlink_set: none,
  hyperlink_remove: none,
  name_add: none,
  name_update: none,
  name_delete: none,
  protect_sheet: none,
  unprotect_sheet: none,
  protect_workbook: none,
  unprotect_workbook: none,
  set_cell_protection: none,
  create_table: tablesGrow,
  update_table: (op) => (op.ref !== undefined ? tablesGrow(op) : []),
  delete_table: (op) =>
    op.mode === 'delete_cells'
      ? [{ kind: 'rewrite', sheet: op.sheet, range: null, why: `the table ${op.table} was deleted with its cells` }]
      : [],
  create_pivot: (op) =>
    op.targetSheet
      ? [{ kind: 'rewrite', sheet: op.targetSheet, range: null, why: `a PivotTable was placed on ${op.targetSheet}` }]
      : [],
  update_pivot: pivotRewrite,
  refresh_pivot: pivotRewrite,
  delete_pivot: pivotRewrite,
  chart_create: none,
  chart_update: none,
  chart_move: none,
  chart_delete: none,
  paste: pasteEffects,
  fill: tablesGrow,
  replace: none,
  merge_cells: (op) => {
    const r = parseRange(op.range)
    return op.mode !== 'unmerge' && r
      ? [{ kind: 'rewrite', sheet: op.sheet, range: r, why: `${op.sheet}!${op.range} was merged` }]
      : []
  },
  clear_range: none,
  set_rich_text: none,
  shift_decimals: none,
  hide_columns: none,
  hide_rows: none,
  group_columns: none,
  ungroup_columns: none,
  group_rows: none,
  ungroup_rows: none,
  collapse_columns: none,
  collapse_rows: none,
  set_outline_level: none,
  autofit_columns: none,
  autofit_rows: none,
  move_sheet: none,
  set_sheet_color: none,
  set_sheet_visibility: none,
  duplicate_sheet: none,
  set_page_setup: none,
  set_view_options: none,
  batch: (op) => op.ops.flatMap(effectsOf),
}

/** Every operation name of the union (what the server accepts). */
export const SHEET_OP_NAMES = Object.keys(COORDS) as OpName[]

function notAnOp(op: SheetOp): never {
  throw new Error(`xlsx collab: “${String(op.op)}” is not a sheet operation.`)
}

export function effectsOf(op: SheetOp): Effect[] {
  // EFFECTS is keyed by every op of the union (a new op without an entry does not compile).
  const fn = (EFFECTS as unknown as Record<string, ((o: SheetOp) => Effect[]) | undefined>)[op.op]
  if (!fn) notAnOp(op)
  return fn(op)
}

function coordsOf(op: SheetOp): Coord[] {
  const known = (COORDS as Record<string, Coord[] | undefined>)[op.op]
  if (!known) notAnOp(op)
  return known
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const limitOf = (axis: Axis) => (axis === 'row' ? MAX_ROWS : MAX_COLS)
const overlaps = (a: Range, b: Range) => a.top <= b.bottom && b.top <= a.bottom && a.left <= b.right && b.left <= a.right
const inside = (a: Range, b: Range) => a.top >= b.top && a.bottom <= b.bottom && a.left >= b.left && a.right <= b.right

// ---------------------------------------------------------------------------
// Moving one coordinate past a shift

function shiftIndex(i: number, e: Shift): number | null {
  if (e.insert) return i >= e.at ? i + e.count : i
  if (i < e.at) return i
  if (i >= e.at + e.count) return i - e.count
  return null
}

function shiftInsertAt(at: number, e: Shift): number {
  if (e.insert) return at >= e.at ? at + e.count : at
  if (at <= e.at) return at
  if (at >= e.at + e.count) return at - e.count
  return e.at
}

function shiftSpan(lo: number, hi: number, e: Shift, limit: number): [number, number] | null {
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

function shiftEdge(n: number, e: Shift): number {
  if (e.insert) return e.at < n ? n + e.count : n
  if (n <= e.at) return n
  return n - Math.min(e.count, n - e.at)
}

function shiftRange(r: Range, e: Shift): Range | null {
  const [lo, hi] = e.axis === 'row' ? (['top', 'bottom'] as const) : (['left', 'right'] as const)
  const s = shiftSpan(r[lo], r[hi], e, limitOf(e.axis))
  return s ? { ...r, [lo]: s[0], [hi]: s[1] } : null
}

function refEditOf(e: Shift): RefEdit {
  return e.insert ? insertEdit(e.sheet, e.axis, e.at, e.count) : deleteEdit(e.sheet, e.axis, e.at, e.count)
}

/** A reference into a block cut on `sheet` and pasted on the same sheet: moved along when wholly inside. */
function blockEdit(e: Extract<Effect, { kind: 'move_block' }>): RefEdit {
  const dr = e.to.row - e.from.top
  const dc = e.to.col - e.from.left
  return (s, r) => {
    if (!same(s, e.fromSheet) || r.top === null || r.left === null || r.bottom === null || r.right === null) return null
    const rect = { top: r.top, left: r.left, bottom: r.bottom, right: r.right }
    if (!inside(rect, e.from)) return null
    if (!same(e.fromSheet, e.toSheet))
      throw new TransformRefusal(`a formula of this change points into cells that were moved to ${e.toSheet} meanwhile`)
    const out: RefRange = { top: r.top + dr, left: r.left + dc, bottom: r.bottom + dr, right: r.right + dc }
    return out
  }
}

/** A formula or reference text past an effect (a leading "=" kept). */
function moveFormula(text: string, home: string, e: Effect): string {
  const eq = text.startsWith('=')
  const body = eq ? text.slice(1) : text
  let out: string
  try {
    if (e.kind === 'shift') out = rewriteRefs(body, home, refEditOf(e))
    else if (e.kind === 'rename') out = renameSheetRefs(body, e.from, e.to)
    else if (e.kind === 'move_block') out = rewriteRefs(body, home, blockEdit(e))
    else return text
  } catch (err) {
    if (err instanceof TransformRefusal) throw err
    // A formula that can't be tokenized is refused when it is applied; it moves as it is.
    return text
  }
  return eq ? `=${out}` : out
}

/** "Sheet2!A1:B3" or "A1:B3" → the sheet (null: unqualified) and the rest. */
function splitQualified(text: string): { sheet: string | null; ref: string } {
  const i = text.lastIndexOf('!')
  if (i < 0) return { sheet: null, ref: text }
  const raw = text.slice(0, i)
  const sheetName = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw
  return { sheet: sheetName, ref: text.slice(i + 1) }
}

// ---------------------------------------------------------------------------
// Paths ("a", "a.b", "list[].a.b")

type Obj = Record<string, unknown>
const DROP = Symbol('drop')
type Mapper = (value: unknown, holder: Obj) => unknown

function getDeep(o: Obj, key: string): unknown {
  let cur: unknown = o
  for (const k of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Obj)[k]
  }
  return cur
}

function setDeep(o: Obj, key: string, v: unknown) {
  const ks = key.split('.')
  let cur = o
  for (const k of ks.slice(0, -1)) cur = cur[k] as Obj
  cur[ks.at(-1)!] = v
}

function splitPath(path: string): { list: string | null; key: string } {
  const i = path.indexOf('[].')
  return i < 0 ? { list: null, key: path } : { list: path.slice(0, i), key: path.slice(i + 3) }
}

/**
 * Maps the value at `path` (`fn` gets it and the object holding the path's
 * start: the operation, or the array element). `DROP` for a top-level value
 * drops the operation (returns false); for an array element it drops the
 * element, and an array left empty drops the operation. Absent and null
 * values are left alone.
 */
function mapPath(op: Obj, path: string, fn: Mapper): boolean {
  const { list, key } = splitPath(path)
  const one = (holder: Obj): unknown => {
    const v = getDeep(holder, key)
    if (v === undefined || v === null) return v
    return fn(v, holder)
  }
  if (list === null) {
    const v = one(op)
    if (v === DROP) return false
    if (v !== undefined && v !== null) setDeep(op, key, v)
    return true
  }
  const items = op[list]
  if (!Array.isArray(items) || items.length === 0) return true
  const kept: unknown[] = []
  for (const item of items as Obj[]) {
    const v = one(item)
    if (v === DROP) continue
    if (v !== undefined && v !== null) setDeep(item, key, v)
    kept.push(item)
  }
  op[list] = kept
  return kept.length > 0
}

/** The sheet a cell/range coordinate is on (the holder's `on` path, else the operation's sheet). */
function sheetOf(c: { on?: string }, out: Obj, holder: Obj, home: string | undefined): string | undefined {
  if (!c.on) return home
  const { list, key } = splitPath(c.on)
  const v = list === null ? getDeep(out, key) : getDeep(holder, key)
  return typeof v === 'string' ? v : home
}

// ---------------------------------------------------------------------------
// Moving an operation's coordinates past one effect

const refuse = (what: string, why: string): never => {
  throw new TransformRefusal(`${what}: ${why} meanwhile.`)
}

/** `op` (a copy) with its coordinates moved past `e`; null when it has nothing left to act on. */
function moveCoords(op: SheetOp, e: Effect): SheetOp | null {
  const out = structuredClone(op) as SheetOp & Obj
  const coords = coordsOf(op)
  const sheetCoord = coords.find((c) => c.kind === 'sheet')
  const home = sheetCoord ? (out[sheetCoord.path] as string | undefined) : undefined
  const what = `This change (${op.op})`

  if (e.kind === 'remove_sheet') {
    if (home !== undefined && same(home, e.sheet)) return null
    for (const c of coords) {
      if (c.kind !== 'sheet_ref') continue
      if (!mapPath(out, c.path, (v) => (typeof v === 'string' && same(v, e.sheet) ? DROP : v))) return null
    }
    return out
  }

  if (e.kind === 'rename') {
    for (const c of coords) {
      if ((c.kind === 'sheet' || c.kind === 'sheet_ref') && c.path.indexOf('[].') < 0) {
        const v = getDeep(out, c.path)
        if (typeof v === 'string' && same(v, e.from)) setDeep(out, c.path, e.to)
      } else if (c.kind === 'sheet_ref') {
        mapPath(out, c.path, (v) => (typeof v === 'string' && same(v, e.from) ? e.to : v))
      } else if (c.kind === 'formula') {
        mapPath(out, c.path, (v) => (typeof v === 'string' ? moveFormula(v, c.home === false ? '' : (home ?? ''), e) : v))
      } else if (c.kind === 'range') {
        mapPath(out, c.path, (v) => {
          if (typeof v !== 'string') return v
          const q = splitQualified(v)
          return q.sheet && same(q.sheet, e.from) ? `${quoteName(e.to)}!${q.ref}` : v
        })
      } else if (c.kind === 'cut_source') {
        const clip = getDeep(out, c.path) as { sheet?: string | null } | undefined
        if (clip?.sheet && same(clip.sheet, e.from)) clip.sheet = e.to
      }
    }
    return out
  }

  for (const c of coords) {
    let ok = true
    switch (c.kind) {
      case 'sheet':
      case 'sheet_ref':
        break
      case 'cell':
        ok = mapPath(out, c.path, (v, holder) => moveCell(v, sheetOf(c, out, holder, home), e, what))
        break
      case 'range':
        ok = mapPath(out, c.path, (v, holder) => moveRangeText(v, sheetOf(c, out, holder, home), e, what))
        break
      case 'index':
        if (e.kind !== 'shift' || home === undefined || !same(home, e.sheet) || c.axis !== e.axis) break
        ok = mapPath(out, c.path, (v) => {
          if (typeof v !== 'number') return v
          const i = shiftIndex(v, e)
          return i === null || i >= limitOf(e.axis) ? DROP : i
        })
        break
      case 'insert_at':
        if (e.kind !== 'shift' || home === undefined || !same(home, e.sheet) || c.axis !== e.axis) break
        mapPath(out, c.path, (v) => (typeof v === 'number' ? shiftInsertAt(v, e) : v))
        break
      case 'span': {
        if (e.kind !== 'shift' || home === undefined || !same(home, e.sheet) || c.axis !== e.axis) break
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
        if (e.kind !== 'shift' || home === undefined || !same(home, e.sheet) || c.axis !== e.axis) break
        mapPath(out, c.path, (v) => (typeof v === 'number' ? shiftEdge(v, e) : v))
        break
      case 'formula':
        mapPath(out, c.path, (v) => (typeof v === 'string' ? moveFormula(v, c.home === false ? '' : (home ?? ''), e) : v))
        break
      case 'anchor':
        ok = mapPath(out, c.path, (v) => {
          if (typeof v === 'string') return moveRangeText(v, home, e, what)
          if (e.kind === 'shift' && home !== undefined && same(home, e.sheet) && typeof v === 'object') {
            const a = v as { from?: Marker; to?: Marker }
            return { ...a, ...(a.from ? { from: moveMarker(a.from, e) } : {}), ...(a.to ? { to: moveMarker(a.to, e) } : {}) }
          }
          return v
        })
        break
      case 'pixels':
        if (e.kind === 'shift' && home !== undefined && same(home, e.sheet) && getDeep(out, c.path) !== undefined)
          refuse(what, `${e.axis === 'row' ? 'rows' : 'columns'} of ${home} were inserted or deleted, so where it lands is not known; place it again`)
        break
      case 'cf_priority':
        if (e.kind === 'cf_renumbered' && home !== undefined && same(home, e.sheet))
          refuse(what, `the conditional formats of ${home} were renumbered`)
        break
      case 'table_ref':
        if (e.kind === 'tables_resized' && home !== undefined && same(home, e.sheet) && getDeep(out, c.path) !== undefined)
          refuse(what, `the tables of ${home} may have grown`)
        if (e.kind === 'shift' || e.kind === 'move_block' || e.kind === 'reorder' || e.kind === 'rewrite')
          ok = mapPath(out, c.path, (v) => moveRangeText(v, home, e, what))
        break
      case 'cut_source': {
        const clip = getDeep(out, c.path) as
          | { sheet: string | null; origin: { row: number; col: number }; rows: number; cols: number }
          | undefined
        if (!clip || !(op as { cut?: boolean }).cut || !clip.sheet) break
        const block = { top: clip.origin.row, left: clip.origin.col, bottom: clip.origin.row + clip.rows - 1, right: clip.origin.col + clip.cols - 1 }
        if (e.kind === 'shift' && same(e.sheet, clip.sheet)) {
          const end = e.axis === 'row' ? block.bottom : block.right
          if (e.at <= end) refuse(what, `${e.axis === 'row' ? 'rows' : 'columns'} were inserted or deleted where you cut from`)
        }
        if ((e.kind === 'move_block' && same(e.fromSheet, clip.sheet) && overlaps(block, e.from)) ||
          ((e.kind === 'reorder' || e.kind === 'rewrite') && same(e.sheet, clip.sheet) && (e.range === null || overlaps(block, e.range))))
          refuse(what, 'the cells you cut were changed as a block')
        break
      }
    }
    if (!ok) return null
  }
  return out
}

type Marker = { col: number; colOff: number; row: number; rowOff: number }

function moveMarker(m: Marker, e: Shift): Marker {
  const k = e.axis === 'row' ? 'row' : 'col'
  const i = shiftIndex(m[k], e)
  // Into a deleted block: to where the block was, at its start.
  if (i === null) return { ...m, [k]: e.at, [e.axis === 'row' ? 'rowOff' : 'colOff']: 0 }
  return { ...m, [k]: Math.min(i, limitOf(e.axis) - 1) }
}

function quoteName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`
}

/** A cell address past an effect on the sheet it is on: moved, `DROP` (deleted), or refused. */
function moveCell(v: unknown, on: string | undefined, e: Effect, what: string): unknown {
  const a = typeof v === 'string' ? parseCell(v) : null
  if (!a || on === undefined) return v
  const r = { top: a.row, bottom: a.row, left: a.col, right: a.col }
  const moved = moveRect(r, on, e, what, true)
  if (moved === DROP) return DROP
  return cellName({ row: moved.top, col: moved.left })
}

/** A range text ("A1:B3", "Sheet2!A1:B3") past an effect. */
function moveRangeText(v: unknown, on: string | undefined, e: Effect, what: string): unknown {
  if (typeof v !== 'string') return v
  const q = splitQualified(v)
  const r = parseRange(q.ref)
  const where = q.sheet ?? on
  if (!r || where === undefined) return v
  const moved = moveRect(r, where, e, what, false)
  if (moved === DROP) return DROP
  const text = rangeName(moved)
  return q.sheet ? `${quoteName(q.sheet)}!${text}` : text
}

/**
 * A rectangle on sheet `on` past an effect. Cells (`single`) move with a
 * cut block; ranges move when wholly inside it. Partly inside a cut, sorted,
 * merged or rewritten block: refused.
 */
function moveRect(r: Range, on: string, e: Effect, what: string, single: boolean): Range | typeof DROP {
  switch (e.kind) {
    case 'shift': {
      if (!same(on, e.sheet)) return r
      const n = shiftRange(r, e)
      if (!n) return DROP
      return n
    }
    case 'move_block': {
      if (!same(on, e.fromSheet) || !overlaps(r, e.from)) return r
      if (!inside(r, e.from)) return refuse(what, `part of ${rangeName(r)} was cut and pasted elsewhere`)
      if (!same(e.fromSheet, e.toSheet))
        return refuse(what, `${rangeName(r)} was cut and pasted onto ${e.toSheet}`)
      const dr = e.to.row - e.from.top
      const dc = e.to.col - e.from.left
      return { top: r.top + dr, bottom: r.bottom + dr, left: r.left + dc, right: r.right + dc }
    }
    case 'reorder':
      if (same(on, e.sheet) && overlaps(r, e.range)) return refuse(what, e.why)
      return r
    case 'rewrite':
      if (!same(on, e.sheet)) return r
      if (e.range === null) return refuse(what, e.why)
      if (!overlaps(r, e.range)) return r
      // A merge keeps its top-left cell: a write there still stands.
      if (single && r.top === e.range.top && r.left === e.range.left) return r
      return refuse(what, e.why)
    default:
      return r
  }
}

// ---------------------------------------------------------------------------
// Transforming

const isDelete = (op: SheetOp): op is MoveOp => op.op === 'delete_rows' || op.op === 'delete_columns'

/** A deletion past a shift on its own axis and sheet: the rows it still deletes, as they are numbered afterwards. */
function moveDeletion(op: MoveOp, e: Shift): SheetOp[] {
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

/** `a` past one effect. */
function past(a: SheetOp, e: Effect): SheetOp[] {
  if (a.op === 'batch') {
    const ops = a.ops.flatMap((x) => past(x, e))
    return ops.length > 0 ? [{ ...a, ops }] : []
  }
  if (e.kind === 'shift' && isDelete(a)) {
    const axis = a.op.endsWith('rows') ? 'row' : 'col'
    if (same(a.sheet, e.sheet) && axis === e.axis) return moveDeletion(a, e)
    return [a]
  }
  const out = moveCoords(a, e)
  return out ? [out] : []
}

/**
 * `a` rewritten to apply after `b` (both made on the same state). Throws
 * TransformRefusal when it can't be made to fit.
 */
export function transform(a: SheetOp, b: SheetOp): SheetOp[] {
  coordsOf(a)
  if (b.op === 'batch') {
    // A batch's operations happen one after another: `a` goes past each in turn.
    let cur = [a]
    for (const x of b.ops) cur = cur.flatMap((c) => transform(c, x))
    return cur
  }
  let cur = [a]
  for (const e of effectsOf(b)) cur = cur.flatMap((x) => past(x, e))
  return cur
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
