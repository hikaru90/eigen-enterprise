import type { ErrorValue, Workbook } from './workbook'
import { parseA1Ref, parseR1C1Ref, parseStructRef } from '@borgar/fx/xlsx'
import { err, Unsupported, type Rect, type RefVal } from './calc-values'
import { MAX_COLS, MAX_ROWS, parseRange, type Range } from './ref'
import { kid, kids, REL } from './xml'

/**
 * References that formulas compute rather than write out: OFFSET, the text
 * INDIRECT reads (A1 and R1C1, sheet-qualified, names, table references),
 * and structured references to Excel tables (ECMA-376 Part 1 §18.5,
 * §18.17.6.2), resolved from the workbook's table parts.
 */

export type Table = {
  /** The name formulas use (displayName). */
  name: string
  sheet: string
  ref: Range
  headerRows: number
  totalsRows: number
  columns: string[]
}

/** Every table of the workbook's worksheets. */
export function readTables(wb: Workbook): Table[] {
  const out: Table[] = []
  for (const s of wb.sheets()) {
    if (s.kind !== 'worksheet') continue
    for (const rel of wb.pkg.relationships(s.part)) {
      if (rel.type !== `${REL}table` || !rel.part || !wb.pkg.has(rel.part)) continue
      const root = wb.pkg.xml(rel.part).documentElement!
      const ref = parseRange(root.getAttribute('ref') ?? '')
      if (!ref) continue
      const cols = kid(root, 'tableColumns')
      out.push({
        name: root.getAttribute('displayName') ?? root.getAttribute('name') ?? '',
        sheet: s.name,
        ref,
        headerRows: Number(root.getAttribute('headerRowCount') ?? 1),
        totalsRows: Number(root.getAttribute('totalsRowCount') ?? 0),
        columns: (cols ? kids(cols, 'tableColumn') : []).map((c) => c.getAttribute('name') ?? ''),
      })
    }
  }
  return out
}

export type At = { sheet: string; row: number; col: number }

const refOf = (sheet: string, r: Rect): RefVal => ({ ref: { sheet, ...r } })

/** The table a cell is in (for unqualified [@Col] references). */
export function tableAt(tables: Table[], at: At): Table | null {
  const k = at.sheet.toLowerCase()
  return (
    tables.find(
      (t) =>
        t.sheet.toLowerCase() === k &&
        at.row >= t.ref.top &&
        at.row <= t.ref.bottom &&
        at.col >= t.ref.left &&
        at.col <= t.ref.right,
    ) ?? null
  )
}

/**
 * A structured reference (`Sales[Qty]`, `Sales[[#Headers],[Price]]`,
 * `[@Qty]`, `Sales[[#This Row],[Qty]]`, `Sales[[A]:[B]]`) → the cells it
 * names, #REF! when the table, column or section isn't there, #VALUE! for
 * "this row" outside the table's rows.
 */
export function resolveStructured(
  text: string,
  tables: Table[],
  at: At | null,
): RefVal | ErrorValue {
  const parsed = parseStructRef(text) as
    { workbookName?: string; table?: string; columns?: string[]; sections?: string[] } | undefined
  if (!parsed) return err('#REF!')
  if (parsed.workbookName) throw new Unsupported('a table in another workbook')
  let table: Table | null
  if (parsed.table) {
    const k = parsed.table.toLowerCase()
    table = tables.find((t) => t.name.toLowerCase() === k) ?? null
  } else {
    if (!at) throw new Unsupported('a table reference without its cell')
    table = tableAt(tables, at)
  }
  if (!table) return err('#REF!')
  return tableRef(table, parsed.sections ?? [], parsed.columns ?? [], at)
}

/** A table's own name used alone (`=ROWS(Sales)`): its data rows. */
export function tableData(table: Table): RefVal | ErrorValue {
  return tableRef(table, [], [], null)
}

function tableRef(
  t: Table,
  sectionsIn: string[],
  columns: string[],
  at: At | null,
): RefVal | ErrorValue {
  const sections = sectionsIn.map((s) => s.toLowerCase())
  const headerRow = t.ref.top
  const dataTop = t.ref.top + t.headerRows
  const dataBottom = t.ref.bottom - t.totalsRows
  let top: number
  let bottom: number
  if (sections.length === 0) {
    top = dataTop
    bottom = dataBottom
  } else if (sections.includes('this row')) {
    if (sections.length > 1) return err('#REF!')
    if (!at) throw new Unsupported('a this-row table reference without its cell')
    if (at.sheet.toLowerCase() !== t.sheet.toLowerCase() || at.row < dataTop || at.row > dataBottom)
      return err('#VALUE!')
    top = bottom = at.row
  } else {
    const spans: Array<[number, number]> = []
    for (const s of sections) {
      if (s === 'all') spans.push([t.ref.top, t.ref.bottom])
      else if (s === 'data') spans.push([dataTop, dataBottom])
      else if (s === 'headers') {
        if (t.headerRows === 0) return err('#REF!')
        spans.push([headerRow, headerRow + t.headerRows - 1])
      } else if (s === 'totals') {
        if (t.totalsRows === 0) return err('#REF!')
        spans.push([dataBottom + 1, t.ref.bottom])
      } else return err('#REF!')
    }
    top = Math.min(...spans.map((x) => x[0]))
    bottom = Math.max(...spans.map((x) => x[1]))
    // Sections must touch (Excel allows Headers+Data and Data+Totals, not Headers+Totals alone).
    const covered = spans.reduce((n, [a, b]) => n + (b - a + 1), 0)
    if (covered < bottom - top + 1) return err('#REF!')
  }
  if (bottom < top) return err('#REF!')
  let left = t.ref.left
  let right = t.ref.right
  if (columns.length > 0) {
    const idx = columns.map((c) => t.columns.findIndex((n) => n.toLowerCase() === c.toLowerCase()))
    if (idx.some((i) => i < 0)) return err('#REF!')
    left = t.ref.left + Math.min(...idx)
    right = t.ref.left + Math.max(...idx)
  }
  return refOf(t.sheet, { top, bottom, left, right })
}

/**
 * OFFSET(reference, rows, cols, [height], [width]): the reference moved and
 * resized; outside the sheet it is #REF!. A zero height or width is #REF!;
 * negative ones (undocumented) are not guessed.
 */
export function offsetRef(
  base: RefVal,
  rows: number,
  cols: number,
  height: number | null,
  width: number | null,
): RefVal | ErrorValue {
  const r = base.ref
  const h = height === null ? r.bottom - r.top + 1 : Math.trunc(height)
  const w = width === null ? r.right - r.left + 1 : Math.trunc(width)
  if (h === 0 || w === 0) return err('#REF!')
  if (h < 0 || w < 0) throw new Unsupported('OFFSET with a negative height or width')
  const top = r.top + Math.trunc(rows)
  const left = r.left + Math.trunc(cols)
  const bottom = top + h - 1
  const right = left + w - 1
  if (top < 0 || left < 0 || bottom >= MAX_ROWS || right >= MAX_COLS) return err('#REF!')
  return refOf(r.sheet, { top, left, bottom, right })
}

/** What an INDIRECT text names: a rectangle (on a sheet, or the formula's own), a defined name, or a table reference. */
export type IndirectTarget =
  | { kind: 'cells'; sheet: string | null; rect: Rect; whole: { rows: boolean; cols: boolean } }
  | { kind: 'name'; name: string; sheet: string | null }
  | { kind: 'table'; text: string }

/** Reads INDIRECT's ref_text (A1 style, or R1C1 when `a1` is false; relative R1C1 counts from `at`). */
export function parseIndirect(
  text: string,
  a1: boolean,
  at: At | null,
): IndirectTarget | ErrorValue {
  const t = text.trim()
  if (t === '') return err('#REF!')
  // A table reference (not a workbook prefix like [Book]Sheet!A1, refused below).
  const struct = /\[/.test(t) && !/^\[[^\]]*\][^[]*!/.test(t) && !!parseStructRef(t)
  if (a1 && struct) return { kind: 'table', text: t }
  if (a1) {
    const ref = parseA1Ref(t, { allowNamed: true }) as
      | {
          workbookName?: string
          sheetName?: string
          name?: string
          range?: {
            top: number | null
            left: number | null
            bottom: number | null
            right: number | null
          }
        }
      | undefined
    if (!ref) return err('#REF!')
    if (ref.workbookName) return err('#REF!')
    if (ref.name !== undefined)
      return { kind: 'name', name: ref.name, sheet: ref.sheetName || null }
    const g = ref.range!
    return cellsTarget(ref.sheetName || null, g.top, g.left, g.bottom, g.right)
  }
  const ref = parseR1C1Ref(t, { allowNamed: true }) as
    | {
        workbookName?: string
        sheetName?: string
        name?: string
        range?: {
          r0?: number | null
          r1?: number | null
          c0?: number | null
          c1?: number | null
          $r0?: boolean | null
          $r1?: boolean | null
          $c0?: boolean | null
          $c1?: boolean | null
        }
      }
    | undefined
  if (!ref) return struct ? { kind: 'table', text: t } : err('#REF!')
  if (ref.workbookName) return err('#REF!')
  if (ref.name !== undefined) {
    if (struct) return { kind: 'table', text: t }
    return { kind: 'name', name: ref.name, sheet: ref.sheetName || null }
  }
  const g = ref.range!
  const relative = [
    [g.r0, g.$r0],
    [g.r1, g.$r1],
    [g.c0, g.$c0],
    [g.c1, g.$c1],
  ].some(([v, abs]) => v !== null && v !== undefined && !abs)
  if (relative && !at) throw new Unsupported('a relative R1C1 reference without its cell')
  const abs = (v: number | null | undefined, isAbs: boolean | null | undefined, base: number) =>
    v === null || v === undefined ? null : isAbs ? v : base + v
  const r0 = abs(g.r0, g.$r0, at?.row ?? 0)
  const c0 = abs(g.c0, g.$c0, at?.col ?? 0)
  const r1 = g.r1 === undefined ? r0 : abs(g.r1, g.$r1, at?.row ?? 0)
  const c1 = g.c1 === undefined ? c0 : abs(g.c1, g.$c1, at?.col ?? 0)
  return cellsTarget(ref.sheetName || null, r0, c0, r1, c1)
}

function cellsTarget(
  sheet: string | null,
  top: number | null,
  left: number | null,
  bottom: number | null,
  right: number | null,
): IndirectTarget | ErrorValue {
  const wholeCols = top === null && bottom === null
  const wholeRows = left === null && right === null
  const t = top ?? 0
  const l = left ?? 0
  const b = bottom ?? (wholeCols ? MAX_ROWS - 1 : t)
  const r = right ?? (wholeRows ? MAX_COLS - 1 : l)
  const rect = {
    top: Math.min(t, b),
    bottom: Math.max(t, b),
    left: Math.min(l, r),
    right: Math.max(l, r),
  }
  if (rect.top < 0 || rect.left < 0 || rect.bottom >= MAX_ROWS || rect.right >= MAX_COLS)
    return err('#REF!')
  return { kind: 'cells', sheet, rect, whole: { rows: wholeRows, cols: wholeCols } }
}
