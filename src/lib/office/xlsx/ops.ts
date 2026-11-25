import type { Calc } from './calc'
import { parse } from '@borgar/fx'
import { tokenize } from '@borgar/fx/xlsx'
import { strToU8 } from 'fflate'
import { relsPartOf } from '../ooxml/package'
import { needsDynamicArray } from './calc-static'
import { runChartOp, shiftChartRefs, type ChartOp } from './chart-ops'
import { drawingPartOf, shiftDrawing, sortDrawing } from './drawing'
import { runDrawingOp, type DrawingOp } from './drawing-ops'
import { filterColumn, setAutoFilter, type AutoFilterOp, type FilterColumnOp } from './filter'
import { runFormatOp, type FormatOp } from './format-cells'
import { toFileText, toShownText } from './formula-text'
import { ensureDynamicArrayCm } from './metadata'
import { runNoteOp, shiftLegacyComments, sortLegacyComments, type NoteOp } from './notes'
import { freezePanes, type FreezeOp } from './panes'
import {
  cellKey,
  cellName,
  colName,
  MAX_COLS,
  MAX_ROWS,
  parseRange,
  rangeName,
  requireCell,
  requireRange,
  type Range,
} from './ref'
import {
  dropEmptyRow,
  ensureCell,
  ensureRow,
  findCell,
  findRow,
  normalizeRefs,
  setDimension,
  sheetDataOf,
  unshareFormulas,
  writeCell,
  type CellContent,
} from './sheet-xml'
import {
  deleteEdit,
  editRange,
  insertEdit,
  parseableTokens,
  refersTo,
  renameSheetRefs,
  rewriteRefs,
  type RefEdit,
} from './shift'
import { sortLosses, sortRange, type SortOp } from './sort'
import { MINIMAL_STYLES, xfWithNumFmt } from './styles'
import { runThreadOp, shiftThreads, sortThreads, type ThreadOp } from './threads'
import {
  isErrorValue,
  relativeTarget,
  XlsxError,
  type CellValue,
  type SheetInfo,
  type Workbook,
} from './workbook'
import {
  all,
  CT_WORKSHEET,
  insertInOrder,
  kid,
  kids,
  make,
  NS_CHART,
  NS_MAIN,
  NS_R,
  REL,
  REL_STYLES,
  REL_WORKSHEET,
  setText,
  textOf,
  WORKBOOK_ORDER,
} from './xml'

/**
 * Changes to a workbook as serializable operations — the grid in the Drive
 * and the agent's drive.sheet_* tools make the same ones. Each runs in one
 * transaction on the Workbook (undoable as a whole).
 *
 * Moving cells (insert/delete rows or columns) moves every formula reference,
 * defined name, merged range, hyperlink, conditional format and validation
 * with them. What lives outside the cells and is not moved (tables, pivot
 * tables, pictures and charts, comments) is reported by `lossesOf` first, and
 * an operation with losses runs only when the caller accepts them.
 */

export type CellWrite = {
  /** "B3" */
  ref: string
  /** A literal (null clears the content; the format stays). */
  value?: string | number | boolean | null
  /** A formula, with or without the leading "=". */
  formula?: string
  /** A number format code written to the cell ("0.00%", "yyyy-mm-dd"). */
  format?: string
  /** A format the typed input implies (a date, a percentage): used only when the cell's format is General. */
  impliedFormat?: string
}

export type SheetOp =
  | { op: 'set_cells'; sheet: string; cells: CellWrite[] }
  | { op: 'set_format'; sheet: string; range: string; format: string }
  | { op: 'add_sheet'; name: string }
  | { op: 'rename_sheet'; sheet: string; name: string }
  | { op: 'delete_sheet'; sheet: string }
  /** `at`: the first row/column index (from 0) that moves (insert) or goes (delete). */
  | {
      op: 'insert_rows' | 'delete_rows' | 'insert_columns' | 'delete_columns'
      sheet: string
      at: number
      count: number
    }
  /** Fonts, fills, borders, alignment, column widths, row heights (./format-cells.ts). */
  | FormatOp
  /** Sort, filter, freeze panes (./sort.ts, ./filter.ts, ./panes.ts). */
  | SortOp
  | AutoFilterOp
  | FilterColumnOp
  | FreezeOp
  /** Pictures, shapes, text boxes (./drawing-ops.ts); notes (./notes.ts); threaded comments (./threads.ts). */
  | DrawingOp
  | NoteOp
  | ThreadOp
  /** Insert, change, move, delete charts (./chart-ops.ts). */
  | ChartOp

/** A feature that would end up wrong after an operation (what, and how many). */
export type Loss = { feature: LossFeature; count: number; detail?: string }
export type LossFeature =
  | 'tables'
  | 'pivot_tables'
  | 'drawings'
  | 'comments'
  | 'threaded_comments'
  | 'controls'
  | 'extensions'
  | 'charts'
  | 'pivot_sources'
  | 'formulas_ref_error'
  | 'names_ref_error'

export class XlsxLossError extends XlsxError {
  constructor(readonly losses: Loss[]) {
    super(
      `This change would leave parts of the workbook wrong: ${losses.map(describeLoss).join('; ')}. Accept the losses to do it anyway.`,
    )
    this.name = 'XlsxLossError'
  }
}

const LOSS_TEXT: Record<LossFeature, string> = {
  tables: 'tables (they keep their old cell ranges)',
  pivot_tables: 'pivot tables (they stay where they are)',
  drawings: 'pictures or shapes on the sheet (they stay where they are; charts move with their cells)',
  comments: 'comments (they stay on their old cells)',
  threaded_comments: 'threaded comments (they stay on their old cells)',
  controls: 'form controls or embedded objects (they stay where they are)',
  extensions: 'newer Excel features such as sparklines or extended conditional formats (not moved)',
  charts: 'charts that use these cells (they keep their old ranges)',
  pivot_sources: 'pivot tables that read these cells (they keep their old source range)',
  formulas_ref_error: 'formulas in other sheets that use it (they will show #REF!)',
  names_ref_error: 'defined names that use it (they will show #REF!)',
}

export const describeLoss = (l: Loss) =>
  `${l.count} × ${LOSS_TEXT[l.feature]}${l.detail ? ` (${l.detail})` : ''}`

/** Functions newer than Excel 2007 are written with the `_xlfn.` prefix (ECMA-376 Part 1 §18.17.7 future functions). */
const FUTURE_FUNCTIONS = new Set([
  'ANCHORARRAY',
  'ARRAYTOTEXT',
  'BYCOL',
  'BYROW',
  'ISOMITTED',
  'LAMBDA',
  'MAKEARRAY',
  'MAP',
  'REDUCE',
  'SCAN',
  'SINGLE',
  'TEXTAFTER',
  'TEXTBEFORE',
  'TEXTSPLIT',
  'VALUETOTEXT',
  'ACOT',
  'ACOTH',
  'AGGREGATE',
  'ARABIC',
  'BASE',
  'BETA.DIST',
  'BETA.INV',
  'BINOM.DIST',
  'BINOM.DIST.RANGE',
  'BINOM.INV',
  'BITAND',
  'BITLSHIFT',
  'BITOR',
  'BITRSHIFT',
  'BITXOR',
  'CEILING.MATH',
  'CEILING.PRECISE',
  'CHISQ.DIST',
  'CHISQ.DIST.RT',
  'CHISQ.INV',
  'CHISQ.INV.RT',
  'CHISQ.TEST',
  'CHOOSECOLS',
  'CHOOSEROWS',
  'COMBINA',
  'CONCAT',
  'CONFIDENCE.NORM',
  'CONFIDENCE.T',
  'COT',
  'COTH',
  'COVARIANCE.P',
  'COVARIANCE.S',
  'CSC',
  'CSCH',
  'DAYS',
  'DECIMAL',
  'DROP',
  'ERF.PRECISE',
  'ERFC.PRECISE',
  'EXPAND',
  'EXPON.DIST',
  'F.DIST',
  'F.DIST.RT',
  'F.INV',
  'F.INV.RT',
  'F.TEST',
  'FILTER',
  'FLOOR.MATH',
  'FLOOR.PRECISE',
  'FORECAST.LINEAR',
  'GAMMA',
  'GAMMA.DIST',
  'GAMMA.INV',
  'GAMMALN.PRECISE',
  'GAUSS',
  'HSTACK',
  'HYPGEOM.DIST',
  'IFNA',
  'IFS',
  'IMCOSH',
  'IMCOT',
  'IMCSC',
  'IMCSCH',
  'IMSEC',
  'IMSECH',
  'IMSINH',
  'IMTAN',
  'ISOWEEKNUM',
  'LET',
  'LOGNORM.DIST',
  'LOGNORM.INV',
  'MAXIFS',
  'MINIFS',
  'MODE.MULT',
  'MODE.SNGL',
  'MUNIT',
  'NEGBINOM.DIST',
  'NORM.DIST',
  'NORM.INV',
  'NORM.S.DIST',
  'NORM.S.INV',
  'NUMBERVALUE',
  'PDURATION',
  'PERCENTILE.EXC',
  'PERCENTILE.INC',
  'PERCENTRANK.EXC',
  'PERCENTRANK.INC',
  'PERMUTATIONA',
  'PHI',
  'POISSON.DIST',
  'QUARTILE.EXC',
  'QUARTILE.INC',
  'RANDARRAY',
  'RANK.AVG',
  'RANK.EQ',
  'RRI',
  'SEC',
  'SECH',
  'SEQUENCE',
  'SHEET',
  'SHEETS',
  'SKEW.P',
  'SORT',
  'SORTBY',
  'STDEV.P',
  'STDEV.S',
  'SWITCH',
  'T.DIST',
  'T.DIST.2T',
  'T.DIST.RT',
  'T.INV',
  'T.INV.2T',
  'T.TEST',
  'TAKE',
  'TEXTJOIN',
  'TOCOL',
  'TOROW',
  'UNICHAR',
  'UNICODE',
  'UNIQUE',
  'VAR.P',
  'VAR.S',
  'VSTACK',
  'WEIBULL.DIST',
  'WRAPCOLS',
  'WRAPROWS',
  'XLOOKUP',
  'XMATCH',
  'XOR',
  'Z.TEST',
])

/** Worksheet-only newer functions: `_xlfn._xlws.` */
const WORKSHEET_FUNCTIONS = new Set(['FILTER', 'SORT'])

type FxToken = { type: string; value: string }
const fxTokens = (f: string) => tokenize(f, { mergeRefs: true }) as FxToken[]

/** A formula as typed → as the file writes it: no "=", newer functions prefixed. Throws when it can't be read. */
export function toFileFormula(input: string, where: string): string {
  const text = input.trim().replace(/^=/, '')
  if (text === '') throw new XlsxError(`${where}: the formula is empty.`)
  try {
    fxTokens(text)
    parse(parseableTokens(text) as never)
  } catch (e) {
    throw new XlsxError(
      `${where}: the formula “=${text}” can't be read (${e instanceof Error ? e.message : String(e)}).`,
    )
  }
  return toFileText(text, FUTURE_FUNCTIONS, WORKSHEET_FUNCTIONS)
}

/** A formula as the file writes it → as people read it (no `_xlfn.`/`_xlpm.` prefixes, `A1#`, `@`). */
export function toShownFormula(formula: string): string {
  if (!/_xl(fn|ws|pm)\./i.test(formula)) return formula
  return toShownText(formula)
}

const SHEET_NAME_BAD = /[\\/?*[\]:]/

/** Excel's sheet-name rules: 1–31 characters, none of \ / ? * [ ] :, no apostrophe at either end, unique (ignoring case), not "History". */
export function checkSheetName(wb: Workbook, name: string, except?: SheetInfo): string {
  const n = name.trim()
  if (n === '') throw new XlsxError('A sheet needs a name.')
  if (n.length > 31)
    throw new XlsxError(`“${n}” is longer than the 31 characters a sheet name can have.`)
  if (SHEET_NAME_BAD.test(n))
    throw new XlsxError(`“${n}”: a sheet name can't contain \\ / ? * [ ] or :.`)
  if (n.startsWith("'") || n.endsWith("'"))
    throw new XlsxError(`“${n}”: a sheet name can't start or end with an apostrophe.`)
  if (n.toLowerCase() === 'history')
    throw new XlsxError('“History” is a name Excel keeps for itself.')
  const clash = wb.findSheet(n)
  if (clash && clash !== except && clash.part !== except?.part)
    throw new XlsxError(`There is already a sheet called “${clash.name}”.`)
  return n
}

// ---------------------------------------------------------------------------
// Losses

function sheetRels(wb: Workbook, info: SheetInfo) {
  return wb.pkg.relationships(info.part).filter((r) => !r.external)
}

const relIs = (type: string, name: string) => type === `${REL}${name}` || type.endsWith(`/${name}`)

function chartParts(wb: Workbook): string[] {
  return wb.pkg.partNames().filter((p) => {
    try {
      return (
        wb.pkg.contentType(p) ===
        'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
      )
    } catch {
      return false
    }
  })
}

function pivotCacheParts(wb: Workbook): string[] {
  return wb.pkg.partNames().filter((p) => {
    try {
      return (
        wb.pkg.contentType(p) ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml'
      )
    } catch {
      return false
    }
  })
}

/** Charts anywhere whose series formulas (`c:f`) read sheet `name`. */
function chartsUsing(wb: Workbook, name: string): number {
  return chartParts(wb).filter((p) =>
    all(wb.pkg.xml(p), 'f', NS_CHART).some((f) => refersTo(textOf(f), name, name)),
  ).length
}

function pivotSourcesUsing(wb: Workbook, name: string): number {
  const key = name.toLowerCase()
  return pivotCacheParts(wb).filter((p) =>
    all(wb.pkg.xml(p), 'worksheetSource').some(
      (s) => (s.getAttribute('sheet') ?? '').toLowerCase() === key,
    ),
  ).length
}

/** What moving cells on `info` would leave behind. */
function movingLosses(wb: Workbook, info: SheetInfo): Loss[] {
  const out: Loss[] = []
  const rels = sheetRels(wb, info)
  const count = (name: string) => rels.filter((r) => relIs(r.type, name)).length
  const add = (feature: LossFeature, n: number) => {
    if (n > 0) out.push({ feature, count: n })
  }
  add('tables', count('table'))
  add('pivot_tables', count('pivotTable'))
  // Pictures, shapes, charts, notes and threaded comments move with the cells (moveCells).
  const root = wb.pkg.xml(info.part).documentElement!
  add('controls', (kid(root, 'controls') ? 1 : 0) + (kid(root, 'oleObjects') ? 1 : 0))
  add('extensions', kid(root, 'extLst') ? 1 : 0)
  add('pivot_sources', pivotSourcesUsing(wb, info.name))
  return out
}

/** What `op` would leave wrong, before it runs (empty: nothing). */
export function lossesOf(wb: Workbook, op: SheetOp): Loss[] {
  switch (op.op) {
    case 'insert_rows':
    case 'delete_rows':
    case 'insert_columns':
    case 'delete_columns':
      return movingLosses(wb, wb.requireWorksheet(op.sheet))
    case 'delete_sheet': {
      const info = wb.requireSheet(op.sheet)
      const out: Loss[] = []
      let formulas = 0
      for (const s of wb.sheets()) {
        if (s.kind !== 'worksheet' || s.part === info.part) continue
        for (const c of wb.sheet(s.name).cells.values())
          if (c.formula && refersTo(c.formula, s.name, info.name)) formulas++
      }
      if (formulas) out.push({ feature: 'formulas_ref_error', count: formulas })
      const names = wb
        .definedNames()
        .filter(
          (n) =>
            n.localSheet !== info.index &&
            refersTo(n.formula, info.name, info.name) &&
            formulaHasSheet(n.formula, info.name),
        ).length
      if (names) out.push({ feature: 'names_ref_error', count: names })
      const charts = chartsUsing(wb, info.name) - chartsOwnedBy(wb, info)
      if (charts > 0) out.push({ feature: 'charts', count: charts })
      const pivots = pivotSourcesUsing(wb, info.name)
      if (pivots) out.push({ feature: 'pivot_sources', count: pivots })
      return out
    }
    case 'sort_range':
      return sortLosses(wb, op)
    default:
      return []
  }
}

/** A defined name's formula names the sheet explicitly (names have no home sheet of their own). */
function formulaHasSheet(formula: string, name: string): boolean {
  return refersTo(formula, '\u0000', name)
}

function chartsOwnedBy(wb: Workbook, info: SheetInfo): number {
  const charts = new Set(chartParts(wb))
  return [...reachableFrom(wb, info.part)].filter(
    (p) =>
      charts.has(p) &&
      all(wb.pkg.xml(p), 'f', NS_CHART).some((f) => refersTo(textOf(f), info.name, info.name)),
  ).length
}

// ---------------------------------------------------------------------------
// Applying

export type OpResult = {
  /** Sheets whose cells or layout changed (by name, after the change). */
  sheets: string[]
  /** The sheet to show afterwards (a new or renamed sheet; the neighbour of a deleted one). */
  focus?: string
  /** The id of what the operation made (a picture, shape or comment). */
  created?: string
}

/** Applies one operation in a transaction; throws (and changes nothing) when it can't, or when it has losses not accepted. */
export function applyOp(
  wb: Workbook,
  op: SheetOp,
  opts: { acceptLosses?: boolean } = {},
): { result: OpResult; images: ReturnType<Workbook['end']> } {
  if (!opts.acceptLosses) {
    const losses = lossesOf(wb, op)
    if (losses.length > 0) throw new XlsxLossError(losses)
  }
  wb.begin()
  try {
    const result = run(wb, op)
    return { result, images: wb.end() }
  } catch (e) {
    wb.abort()
    throw e
  }
}

function run(wb: Workbook, op: SheetOp): OpResult {
  switch (op.op) {
    case 'set_cells':
      return setCells(wb, op.sheet, op.cells)
    case 'set_format':
      return setFormat(wb, op.sheet, op.range, op.format)
    case 'add_sheet':
      return addSheet(wb, op.name)
    case 'rename_sheet':
      return renameSheet(wb, op.sheet, op.name)
    case 'delete_sheet':
      return deleteSheet(wb, op.sheet)
    case 'insert_rows':
    case 'delete_rows':
    case 'insert_columns':
    case 'delete_columns':
      return moveCells(wb, op)
    case 'set_style':
    case 'set_column_width':
    case 'set_row_height':
      return runFormatOp(wb, op)
    case 'sort_range':
    case 'set_autofilter':
    case 'filter_column':
    case 'freeze_panes':
      return arrange(wb, op)
    case 'insert_picture':
    case 'insert_shape':
    case 'update_drawing':
    case 'delete_drawing':
      return runDrawingOp(wb, op)
    case 'set_note':
    case 'delete_note':
    case 'add_comment':
    case 'reply_comment':
    case 'edit_comment':
    case 'resolve_comment':
    case 'delete_comment':
      return annotate(wb, op)
    case 'chart_create':
    case 'chart_update':
    case 'chart_move':
    case 'chart_delete':
      return runChartOp(wb, op)
  }
}

/** Notes and threaded comments: the sheet's comment parts (and, for a new one, its VML drawing). */
function annotate(wb: Workbook, op: NoteOp | ThreadOp): OpResult {
  const info = wb.requireWorksheet(op.sheet)
  let doc: XMLDocument | null = null
  const getDoc = () => (doc ??= sheetDoc(wb, info))
  const created =
    op.op === 'set_note' || op.op === 'delete_note' ? runNoteOp(wb, op, getDoc) : runThreadOp(wb, op, getDoc)
  if (doc) finishSheet(wb, info, doc)
  return created ? { sheets: [info.name], created } : { sheets: [info.name] }
}

/** Sort, filter and freeze panes: one sheet's XML, its cached model rebuilt after. */
function arrange(wb: Workbook, op: SortOp | AutoFilterOp | FilterColumnOp | FreezeOp): OpResult {
  const info = wb.requireWorksheet(op.sheet)
  const doc = sheetDoc(wb, info)
  if (op.op === 'sort_range') {
    const sorted = sortRange(wb, doc, op)
    if (!sorted) return { sheets: [] }
    // Notes, comment threads and one-row pictures on the sorted cells go with their rows, as in Excel.
    const { body, dest } = sorted
    sortLegacyComments(wb, info, dest, body.left, body.right)
    sortThreads(wb, info, dest, body.left, body.right)
    const drawing = drawingPartOf(wb, info)
    if (drawing && sortDrawing(wb.pkg.xml(drawing), dest, body.left, body.right)) wb.edit(drawing)
  } else if (op.op === 'set_autofilter') setAutoFilter(wb, info, doc, op)
  else if (op.op === 'filter_column') filterColumn(wb, info, doc, op)
  else freezePanes(doc, op)
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

/** The editable worksheet document (refs made explicit on first touch). */
export function sheetDoc(wb: Workbook, info: SheetInfo): XMLDocument {
  const doc = wb.edit(info.part)
  normalizeRefs(doc)
  return doc
}

export function stylesDoc(wb: Workbook): XMLDocument {
  let part = wb.stylesPart()
  if (!part) {
    part = '/xl/styles.xml'
    wb.write(
      part,
      strToU8(MINIMAL_STYLES),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
    )
    wb.touch(relsPartOf(wb.part))
    wb.pkg.addRelationship(wb.part, REL_STYLES, relativeTarget(wb.part, part))
  }
  return wb.edit(part)
}

function inRange(r: Range, row: number, col: number) {
  return row >= r.top && row <= r.bottom && col >= r.left && col <= r.right
}

function setCells(wb: Workbook, sheet: string, writes: CellWrite[]): OpResult {
  const info = wb.requireWorksheet(sheet)
  if (writes.length === 0) return { sheets: [] }
  const data = wb.sheet(info.name)
  const styles = wb.styles()
  // Validate everything before the first change.
  const planned = writes.map((w) => {
    const addr = requireCell(w.ref)
    const where = `${info.name}!${cellName(addr)}`
    const given = [w.value !== undefined, w.formula !== undefined].filter(Boolean).length
    if (given > 1) throw new XlsxError(`${where}: give a value or a formula, not both.`)
    if (given === 0 && w.format === undefined)
      throw new XlsxError(`${where}: nothing to write (value, formula or format).`)
    const cur = data.cells.get(cellKey(addr.row, addr.col))
    const arr = cur?.formulaRef && cur.formulaType !== 'normal' ? cur.formulaRef : cur?.inArrayOf
    const dynamicArr = arr ? data.cells.get(cellKey(arr.top, arr.left))?.dynamic === true : false
    if (arr && !dynamicArr && (w.value !== undefined || w.formula !== undefined))
      throw new XlsxError(
        `${where} is part of the array formula in ${rangeName(arr)}, which this editor can't change; edit it in Excel.`,
      )
    const merge = data.merges.find(
      (m) => inRange(m, addr.row, addr.col) && (m.top !== addr.row || m.left !== addr.col),
    )
    if (merge && (w.value !== undefined || w.formula !== undefined))
      throw new XlsxError(
        `${where} is inside the merged cells ${rangeName(merge)}; write to ${cellName({ row: merge.top, col: merge.left })}.`,
      )
    let content: CellContent | null = null
    if (w.formula !== undefined) {
      const formula = toFileFormula(w.formula, where)
      content = needsDynamicArray(formula, wb)
        ? { kind: 'formula', formula, dynamicCm: 0 }
        : { kind: 'formula', formula }
    } else if (w.value !== undefined)
      content =
        w.value === null || w.value === '' ? { kind: 'clear' } : { kind: 'value', value: w.value }
    return { addr, w, cur, content }
  })
  const doc = sheetDoc(wb, info)
  if (planned.some((p) => p.content?.kind === 'formula' && p.content.dynamicCm !== undefined)) {
    const cm = ensureDynamicArrayCm(wb)
    for (const p of planned)
      if (p.content?.kind === 'formula' && p.content.dynamicCm !== undefined)
        p.content.dynamicCm = cm
  }
  clearSpillsUnder(wb, doc, data, planned)
  // A shared formula's anchor is about to change: its group is written out per cell first.
  const anchors = new Set<string>()
  for (const p of planned)
    if (p.cur?.formulaType === 'shared' && p.content) anchors.add(cellName(p.addr))
  if (anchors.size > 0)
    unshareFormulas(
      doc,
      (ref) => data.cells.get(cellKey(requireCell(ref).row, requireCell(ref).col))?.formula ?? null,
    )
  let sdoc: XMLDocument | null = null
  for (const p of planned) {
    const curStyle = p.cur?.style ?? 0
    let style: number | undefined
    const code =
      p.w.format ??
      (p.w.impliedFormat && styles.xf(curStyle).numFmtId === 0 ? p.w.impliedFormat : undefined)
    if (code !== undefined) {
      sdoc ??= stylesDoc(wb)
      style = xfWithNumFmt(sdoc, curStyle, code)
    }
    if (p.content) writeCell(wb, doc, p.addr.row, p.addr.col, p.content, style)
    else if (style !== undefined) restyle(wb, doc, p.addr.row, p.addr.col, style)
  }
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

/**
 * Writing over a dynamic array: a new anchor content clears the old spill;
 * content in a spilled cell blocks the spill (the formula keeps only its own
 * cell, Excel shows #SPILL!) and the rest of the old spill is cleared.
 */
function clearSpillsUnder(
  wb: Workbook,
  doc: XMLDocument,
  data: ReturnType<Workbook['sheet']>,
  planned: Array<{ addr: { row: number; col: number }; content: CellContent | null }>,
) {
  const written = new Set(
    planned.filter((p) => p.content).map((p) => cellKey(p.addr.row, p.addr.col)),
  )
  const anchors = new Map<number, Range>()
  for (const p of planned) {
    if (!p.content) continue
    const cur = data.cells.get(cellKey(p.addr.row, p.addr.col))
    const r = cur?.formulaType === 'array' && cur.dynamic ? cur.formulaRef : cur?.inArrayOf
    if (!r) continue
    const anchor = data.cells.get(cellKey(r.top, r.left))
    if (!anchor?.dynamic || (isErrorValue(anchor.value) && anchor.value.error === '#SPILL!'))
      continue
    anchors.set(cellKey(r.top, r.left), r)
  }
  for (const [key, r] of anchors) {
    for (let row = r.top; row <= r.bottom; row++)
      for (let col = r.left; col <= r.right; col++) {
        const k = cellKey(row, col)
        if (k === key || written.has(k)) continue
        const c = data.cells.get(k)
        if (c && c.formula === null && c.inArrayOf) writeCell(wb, doc, row, col, { kind: 'clear' })
      }
    if (!written.has(key)) {
      const rowEl = findRow(doc, r.top)
      const cell = rowEl ? findCell(rowEl, r.left) : null
      const f = cell ? kid(cell, 'f') : null
      if (f) f.setAttribute('ref', cellName({ row: r.top, col: r.left }))
    }
  }
}

/** Gives a cell a new format, keeping its content. */
export function restyle(wb: Workbook, doc: XMLDocument, row: number, col: number, style: number) {
  const rowEl = kids(sheetDataOf(doc), 'row').find((r) => Number(r.getAttribute('r')) - 1 === row)
  const cell = rowEl
    ? kids(rowEl, 'c').find((c) => c.getAttribute('r') === cellName({ row, col }))
    : null
  if (cell) {
    if (style === 0) cell.removeAttribute('s')
    else cell.setAttribute('s', String(style))
    return
  }
  writeCell(wb, doc, row, col, { kind: 'clear' }, style)
}

const MAX_FORMAT_CELLS = 100_000

function setFormat(wb: Workbook, sheet: string, rangeText: string, code: string): OpResult {
  const info = wb.requireWorksheet(sheet)
  const range = requireRange(rangeText)
  const n = (range.bottom - range.top + 1) * (range.right - range.left + 1)
  if (n > MAX_FORMAT_CELLS)
    throw new XlsxError(
      `${rangeName(range)} is ${n} cells; format at most ${MAX_FORMAT_CELLS} at a time.`,
    )
  if (code.trim() === '')
    throw new XlsxError('A number format needs a format code (like 0.00 or yyyy-mm-dd).')
  const data = wb.sheet(info.name)
  const doc = sheetDoc(wb, info)
  const sdoc = stylesDoc(wb)
  const memo = new Map<number, number>()
  for (let r = range.top; r <= range.bottom; r++) {
    for (let c = range.left; c <= range.right; c++) {
      const cur = data.cells.get(cellKey(r, c))?.style ?? 0
      let next = memo.get(cur)
      if (next === undefined) {
        next = xfWithNumFmt(sdoc, cur, code)
        memo.set(cur, next)
      }
      if (next !== cur) restyle(wb, doc, r, c, next)
    }
  }
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

/** After editing a sheet's XML: its dimension and cached model follow. */
export function finishSheet(wb: Workbook, info: SheetInfo, doc: XMLDocument) {
  wb.forgetSheet(info.part)
  const d = wb.sheet(info.name)
  setDimension(
    doc,
    d.maxRow < 0 ? 'A1' : rangeName({ top: 0, left: 0, bottom: d.maxRow, right: d.maxCol }),
  )
  wb.forgetSheet(info.part)
}

function workbookRoot(wb: Workbook): Element {
  return wb.edit(wb.part).documentElement!
}

function addSheet(wb: Workbook, nameIn: string): OpResult {
  const name = checkSheetName(wb, nameIn)
  const dir = wb.part.slice(0, wb.part.lastIndexOf('/'))
  let n = wb.sheets().length + 1
  let part = `${dir}/worksheets/sheet${n}.xml`
  while (wb.pkg.has(part)) part = `${dir}/worksheets/sheet${++n}.xml`
  wb.write(
    part,
    strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`,
    ),
    CT_WORKSHEET,
  )
  wb.touch(relsPartOf(wb.part))
  const relId = wb.pkg.addRelationship(wb.part, REL_WORKSHEET, relativeTarget(wb.part, part))
  const root = workbookRoot(wb)
  const doc = root.ownerDocument!
  const sheets = kid(root, 'sheets')!
  const el = make(doc, 'sheet')
  el.setAttribute('name', name)
  el.setAttribute('sheetId', String(Math.max(0, ...wb.sheets().map((s) => s.sheetId)) + 1))
  const rPrefix = root.lookupPrefix(NS_R) ?? 'r'
  if (!root.lookupPrefix(NS_R)) root.setAttribute('xmlns:r', NS_R)
  el.setAttributeNS(NS_R, `${rPrefix}:id`, relId)
  sheets.appendChild(el)
  wb.forgetSheet(part)
  return { sheets: [name], focus: name }
}

function renameSheet(wb: Workbook, sheet: string, nameIn: string): OpResult {
  const info = wb.requireSheet(sheet)
  const name = checkSheetName(wb, nameIn, info)
  if (name === info.name) return { sheets: [] }
  const from = info.name
  const root = workbookRoot(wb)
  kids(kid(root, 'sheets')!, 'sheet')[info.index]!.setAttribute('name', name)
  // Every formula that names the sheet follows the new name.
  rewriteAllFormulas(wb, (f) => renameSheetRefs(f, from, name))
  for (const s of wb.sheets()) {
    if (s.kind !== 'worksheet') continue
    const doc = wb.pkg.xml(s.part)
    const links = all(doc, 'hyperlink').filter(
      (h) =>
        h.getAttribute('location') &&
        renameSheetRefs(h.getAttribute('location')!, from, name) !== h.getAttribute('location'),
    )
    if (links.length === 0) continue
    wb.edit(s.part)
    for (const h of links)
      h.setAttribute('location', renameSheetRefs(h.getAttribute('location')!, from, name))
  }
  for (const p of chartParts(wb)) {
    const fs = all(wb.pkg.xml(p), 'f', NS_CHART).filter(
      (f) => renameSheetRefs(textOf(f), from, name) !== textOf(f),
    )
    if (fs.length === 0) continue
    const doc = wb.edit(p)
    for (const f of fs) setText(doc, f, renameSheetRefs(textOf(f), from, name))
  }
  for (const p of pivotCacheParts(wb)) {
    const srcs = all(wb.pkg.xml(p), 'worksheetSource').filter(
      (s) => (s.getAttribute('sheet') ?? '').toLowerCase() === from.toLowerCase(),
    )
    if (srcs.length === 0) continue
    wb.edit(p)
    for (const s of srcs) s.setAttribute('sheet', name)
  }
  wb.invalidate()
  return { sheets: [name], focus: name }
}

/**
 * Rewrites every formula of the workbook — cells, defined names, conditional
 * formats and data validations — editing only the parts where one changes.
 */
function rewriteAllFormulas(wb: Workbook, rewrite: (formula: string, home: string) => string) {
  for (const s of wb.sheets()) {
    if (s.kind !== 'worksheet') continue
    const doc = wb.pkg.xml(s.part)
    const targets = [
      ...all(doc, 'f'),
      ...all(doc, 'formula'),
      ...all(doc, 'formula1'),
      ...all(doc, 'formula2'),
    ]
    const changes = targets.flatMap((el) => {
      const t = textOf(el)
      if (t === '') return []
      const next = rewrite(t, s.name)
      return next === t ? [] : [{ el, next }]
    })
    if (changes.length === 0) continue
    const edit = wb.edit(s.part)
    for (const c of changes) setText(edit, c.el, c.next)
  }
  const namesEl = kid(wb.pkg.xml(wb.part).documentElement!, 'definedNames')
  if (namesEl) {
    const sheets = wb.sheets()
    const changes = kids(namesEl, 'definedName').flatMap((el) => {
      const local = el.getAttribute('localSheetId')
      const home = local !== null ? (sheets[Number(local)]?.name ?? '\u0000') : '\u0000'
      const next = rewrite(textOf(el), home)
      return next === textOf(el) ? [] : [{ el, next }]
    })
    if (changes.length > 0) {
      const doc = wb.edit(wb.part)
      for (const c of changes) setText(doc, c.el, c.next)
    }
  }
}

/** Every part reachable from `start` through internal relationships (start included). */
function reachableFrom(wb: Workbook, start: string): Set<string> {
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length) {
    const p = stack.pop()!
    if (seen.has(p) || (p !== '/' && !wb.pkg.has(p))) continue
    seen.add(p)
    for (const r of wb.pkg.relationships(p)) if (!r.external && r.part) stack.push(r.part)
  }
  return seen
}

function deleteSheet(wb: Workbook, sheet: string): OpResult {
  const info = wb.requireSheet(sheet)
  const sheets = wb.sheets()
  if (sheets.length === 1)
    throw new XlsxError('A workbook needs at least one sheet, so the last one can’t be deleted.')
  if (info.state === 'visible' && sheets.filter((s) => s.state === 'visible').length === 1)
    throw new XlsxError(
      'A workbook needs at least one visible sheet, so this one can’t be deleted.',
    )
  // Formulas that read the sheet now read #REF! (as in Excel).
  const gone = (s: string) => s.toLowerCase() === info.name.toLowerCase()
  rewriteAllFormulas(wb, (f, home) =>
    gone(home) ? f : rewriteRefs(f, home, (s) => (gone(s) ? '#REF!' : null), { bare: true }),
  )
  const owned = reachableFrom(wb, info.part)
  const root = workbookRoot(wb)
  const sheetsEl = kid(root, 'sheets')!
  sheetsEl.removeChild(kids(sheetsEl, 'sheet')[info.index]!)
  // Names local to it go; local names of later sheets keep their sheet (indexes move down by one).
  const namesEl = kid(root, 'definedNames')
  if (namesEl) {
    for (const el of kids(namesEl, 'definedName')) {
      const local = el.getAttribute('localSheetId')
      if (local === null) continue
      const i = Number(local)
      if (i === info.index) namesEl.removeChild(el)
      else if (i > info.index) el.setAttribute('localSheetId', String(i - 1))
    }
    if (kids(namesEl, 'definedName').length === 0) root.removeChild(namesEl)
  }
  const count = sheets.length - 1
  for (const v of all(root.ownerDocument!, 'workbookView')) {
    for (const attr of ['activeTab', 'firstSheet']) {
      const a = v.getAttribute(attr)
      if (a === null) continue
      let i = Number(a)
      if (i > info.index) i--
      v.setAttribute(attr, String(Math.min(Math.max(0, i), count - 1)))
    }
  }
  const relsDoc = wb.edit(relsPartOf(wb.part))
  for (const r of kids(
    relsDoc.documentElement!,
    'Relationship',
    'http://schemas.openxmlformats.org/package/2006/relationships',
  ))
    if (r.getAttribute('Id') === info.relId) relsDoc.documentElement!.removeChild(r)
  // The sheet's own parts (drawings, comments, tables …) go when nothing else uses them.
  wb.remove(info.part)
  const live = reachableFrom(wb, '/')
  for (const p of owned) {
    if (p === '/' || live.has(p)) continue
    wb.remove(p)
    wb.remove(relsPartOf(p))
  }
  wb.remove(relsPartOf(info.part))
  wb.invalidate()
  const next = wb.sheets()[Math.min(info.index, count - 1)]!
  return { sheets: [], focus: next.name }
}

type MoveOp = Extract<
  SheetOp,
  { op: 'insert_rows' | 'delete_rows' | 'insert_columns' | 'delete_columns' }
>

function moveCells(wb: Workbook, op: MoveOp): OpResult {
  const info = wb.requireWorksheet(op.sheet)
  const axis = op.op.endsWith('rows') ? 'row' : 'col'
  const insert = op.op.startsWith('insert')
  const limit = axis === 'row' ? MAX_ROWS : MAX_COLS
  if (!Number.isInteger(op.at) || op.at < 0 || op.at >= limit)
    throw new XlsxError(
      `${axis === 'row' ? 'Row' : 'Column'} ${axis === 'row' ? op.at + 1 : colName(op.at)} is outside the sheet.`,
    )
  if (!Number.isInteger(op.count) || op.count < 1 || op.at + op.count > limit)
    throw new XlsxError(
      `${op.count} ${axis === 'row' ? 'rows' : 'columns'} from there would go past the end of the sheet.`,
    )
  const data = wb.sheet(info.name)
  if (insert) {
    const last = axis === 'row' ? data.maxRow : data.maxCol
    if (last + op.count >= limit)
      throw new XlsxError(`Inserting would push cells past the end of the sheet.`)
  }
  const edit: RefEdit = insert
    ? insertEdit(info.name, axis, op.at, op.count)
    : deleteEdit(info.name, axis, op.at, op.count)

  // Shared formulas everywhere are written out per cell first: their relative references would otherwise move unevenly.
  for (const s of wb.sheets()) {
    if (s.kind !== 'worksheet') continue
    if (!all(wb.pkg.xml(s.part), 'f').some((f) => f.getAttribute('t') === 'shared')) continue
    const sd = wb.sheet(s.name)
    unshareFormulas(sheetDoc(wb, s), (ref) => {
      const a = requireCell(ref)
      return sd.cells.get(cellKey(a.row, a.col))?.formula ?? null
    })
  }
  rewriteAllFormulas(wb, (f, home) => rewriteRefs(f, home, edit))

  const doc = sheetDoc(wb, info)
  const root = doc.documentElement!
  const shift = (i: number) =>
    insert ? (i >= op.at ? i + op.count : i) : i > op.at + op.count - 1 ? i - op.count : i
  const doomed = (i: number) => !insert && i >= op.at && i < op.at + op.count
  for (const rowEl of kids(sheetDataOf(doc), 'row')) {
    const r = Number(rowEl.getAttribute('r')) - 1
    if (axis === 'row') {
      if (doomed(r)) {
        rowEl.parentNode!.removeChild(rowEl)
        continue
      }
      const nr = shift(r)
      if (nr !== r) rowEl.setAttribute('r', String(nr + 1))
      rowEl.removeAttribute('spans')
      for (const c of kids(rowEl, 'c')) {
        const col = requireCell(c.getAttribute('r')!).col
        c.setAttribute('r', cellName({ row: nr, col }))
      }
    } else {
      rowEl.removeAttribute('spans')
      for (const c of kids(rowEl, 'c')) {
        const col = requireCell(c.getAttribute('r')!).col
        if (doomed(col)) rowEl.removeChild(c)
        else c.setAttribute('r', cellName({ row: r, col: shift(col) }))
      }
      dropEmptyRow(rowEl)
    }
  }
  // Array formula ranges on this sheet.
  for (const f of all(doc, 'f')) {
    const ref = f.getAttribute('ref')
    if (!ref || (f.getAttribute('t') !== 'array' && f.getAttribute('t') !== 'dataTable')) continue
    const r = parseRange(ref)
    const moved = r && editRange(r, info.name, edit)
    if (moved) f.setAttribute('ref', rangeName(moved))
  }
  if (axis === 'col') {
    const colsEl = kid(root, 'cols')
    for (const col of colsEl ? kids(colsEl, 'col') : []) {
      const r = {
        top: 0,
        bottom: 0,
        left: Number(col.getAttribute('min')) - 1,
        right: Number(col.getAttribute('max')) - 1,
      }
      const moved = editRange(r, info.name, edit)
      if (!moved) colsEl!.removeChild(col)
      else {
        col.setAttribute('min', String(moved.left + 1))
        col.setAttribute('max', String(moved.right + 1))
      }
    }
    if (colsEl && kids(colsEl, 'col').length === 0) root.removeChild(colsEl)
  }
  const moveRefAttr = (el: Element, attr: string, list: boolean) => {
    const text = el.getAttribute(attr)
    if (!text) return true
    const parts = (list ? text.split(/\s+/) : [text]).flatMap((t) => {
      const r = parseRange(t)
      if (!r) return [t]
      const moved = editRange(r, info.name, edit)
      return moved ? [rangeName(moved)] : []
    })
    if (parts.length === 0) return false
    el.setAttribute(attr, parts.join(' '))
    return true
  }
  const mergeEl = kid(root, 'mergeCells')
  for (const m of mergeEl ? kids(mergeEl, 'mergeCell') : []) {
    const kept = moveRefAttr(m, 'ref', false)
    const r = kept ? parseRange(m.getAttribute('ref') ?? '') : null
    if (!kept || (r && r.top === r.bottom && r.left === r.right)) mergeEl!.removeChild(m)
  }
  if (mergeEl) {
    const n = kids(mergeEl, 'mergeCell').length
    if (n === 0) root.removeChild(mergeEl)
    else mergeEl.setAttribute('count', String(n))
  }
  const links = kid(root, 'hyperlinks')
  for (const h of links ? kids(links, 'hyperlink') : [])
    if (!moveRefAttr(h, 'ref', false)) links!.removeChild(h)
  if (links && kids(links, 'hyperlink').length === 0) root.removeChild(links)
  for (const cf of kids(root, 'conditionalFormatting'))
    if (!moveRefAttr(cf, 'sqref', true)) root.removeChild(cf)
  const dvs = kid(root, 'dataValidations')
  for (const dv of dvs ? kids(dvs, 'dataValidation') : [])
    if (!moveRefAttr(dv, 'sqref', true)) dvs!.removeChild(dv)
  if (dvs) {
    const n = kids(dvs, 'dataValidation').length
    if (n === 0) root.removeChild(dvs)
    else dvs.setAttribute('count', String(n))
  }
  const af = kid(root, 'autoFilter')
  if (af && !moveRefAttr(af, 'ref', false)) root.removeChild(af)
  // Every anchor (pictures, shapes, charts) moves once, here; charts' series references follow the cells.
  const drawing = drawingPartOf(wb, info)
  if (drawing && shiftDrawing(wb.pkg.xml(drawing), axis, op.at, op.count, insert)) wb.edit(drawing)
  shiftChartRefs(wb, edit)
  shiftLegacyComments(wb, info, doc, edit)
  shiftThreads(wb, info, edit)
  finishSheet(wb, info, doc)
  wb.invalidate()
  return { sheets: [info.name] }
}

// ---------------------------------------------------------------------------
// Saving: calculated values written back

/**
 * Before a save: every formula this engine calculates gets its new cached
 * value (what other programs and Excel's first paint show); the calculation
 * chain is dropped and Excel is told to recalculate on open, so nothing
 * stale is trusted. Formulas it can't calculate keep the value they had.
 */
export function prepareSave(wb: Workbook, calc: Pick<Calc, 'cell' | 'spill'>) {
  wb.begin()
  try {
    for (const s of wb.sheets()) {
      if (s.kind !== 'worksheet') continue
      const data = wb.sheet(s.name)
      const changes: Array<{ row: number; col: number; v: CellValue }> = []
      const refs: Array<{ row: number; col: number; ref: string }> = []
      const clears: Array<{ row: number; col: number }> = []
      const differs = (row: number, col: number, v: CellValue) => {
        const cur = data.cells.get(cellKey(row, col))
        if (!cur || !sameValue(v, cur.value)) changes.push({ row, col, v })
      }
      for (const c of data.cells.values()) {
        if (c.formula === null) continue
        if (c.formulaType === 'normal' || c.formulaType === 'shared') {
          const out = calc.cell(s.name, c.row, c.col)
          if (!out.kept) differs(c.row, c.col, out.value)
        } else if (c.formulaType === 'array' && c.dynamic) {
          const sp = calc.spill(s.name, c.row, c.col)
          if (!sp) continue
          const now = parseRange(sp.range)!
          sp.values.forEach((line, r) =>
            line.forEach((v, k) => differs(now.top + r, now.left + k, v)),
          )
          const old = c.formulaRef
          if (old && rangeName(old) !== sp.range) {
            refs.push({ row: c.row, col: c.col, ref: sp.range })
            // Excel's old spill outside the new one (not when it was blocked: those cells are the blockers).
            const wasBlocked = isErrorValue(c.value) && c.value.error === '#SPILL!'
            for (let r = old.top; r <= old.bottom && !wasBlocked; r++)
              for (let k = old.left; k <= old.right; k++) {
                if (r >= now.top && r <= now.bottom && k >= now.left && k <= now.right) continue
                const cell = data.cells.get(cellKey(r, k))
                if (cell && cell.formula === null && cell.value !== null)
                  clears.push({ row: r, col: k })
              }
          }
        } else if (c.formulaType === 'array' && c.formulaRef) {
          const range = c.formulaRef
          for (let r = range.top; r <= range.bottom; r++)
            for (let k = range.left; k <= range.right; k++) {
              const out = calc.cell(s.name, r, k)
              if (!out.kept) differs(r, k, out.value)
            }
        }
      }
      if (changes.length === 0 && refs.length === 0 && clears.length === 0) continue
      const doc = wb.edit(s.part)
      normalizeRefs(doc)
      for (const ch of clears) writeCell(wb, doc, ch.row, ch.col, { kind: 'clear' })
      for (const ch of changes)
        setCachedValue(doc, ensureCell(doc, ensureRow(doc, ch.row), ch.row, ch.col), ch.v)
      for (const r of refs) {
        const rowEl = findRow(doc, r.row)
        const cell = rowEl ? findCell(rowEl, r.col) : null
        const f = cell ? kid(cell, 'f') : null
        if (f) f.setAttribute('ref', r.ref)
      }
      finishSheet(wb, s, doc)
    }
    const root = wb.pkg.xml(wb.part).documentElement!
    const chain = wb.pkg.relationships(wb.part).filter((r) => r.type === `${REL}calcChain`)
    if (chain.length > 0) {
      const relsDoc = wb.edit(relsPartOf(wb.part))
      for (const r of kids(
        relsDoc.documentElement!,
        'Relationship',
        'http://schemas.openxmlformats.org/package/2006/relationships',
      ))
        if (chain.some((c) => c.id === r.getAttribute('Id')))
          relsDoc.documentElement!.removeChild(r)
      for (const c of chain) if (c.part) wb.remove(c.part)
    }
    const calcPr = kid(root, 'calcPr')
    if (calcPr?.getAttribute('fullCalcOnLoad') !== '1') {
      const doc = wb.edit(wb.part)
      let el = kid(doc.documentElement!, 'calcPr')
      if (!el) {
        el = make(doc, 'calcPr')
        insertInOrder(doc.documentElement!, el, WORKBOOK_ORDER)
      }
      el.setAttribute('fullCalcOnLoad', '1')
    }
    wb.end()
  } catch (e) {
    wb.abort()
    throw e
  }
}

function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === b) return true
  if (typeof a === 'object' && typeof b === 'object' && a && b) return a.error === b.error
  return false
}

function setCachedValue(doc: XMLDocument, cell: Element, v: CellValue) {
  for (const k of kids(cell, undefined))
    if (k.localName === 'v' || k.localName === 'is') cell.removeChild(k)
  cell.removeAttribute('t')
  if (v === null) return
  const el = make(doc, 'v')
  if (typeof v === 'string') {
    cell.setAttribute('t', 'str')
    setText(doc, el, v)
  } else if (typeof v === 'boolean') {
    cell.setAttribute('t', 'b')
    el.appendChild(doc.createTextNode(v ? '1' : '0'))
  } else if (typeof v === 'number') el.appendChild(doc.createTextNode(String(v)))
  else {
    cell.setAttribute('t', 'e')
    el.appendChild(doc.createTextNode(v.error))
  }
  const f = kid(cell, 'f')
  cell.insertBefore(el, f ? f.nextSibling : cell.firstChild)
}
