import type { SheetEditor } from './editor'
import { translateFormulaToA1, translateFormulaToR1C1 } from '@borgar/fx'
import { parseA1Ref, stringifyA1Ref, tokenize } from '@borgar/fx/xlsx'
import { needsDynamicArray } from './calc-static'
import { autoFilterOf } from './filter'
import { displayValue, formatCode, type SheetLocale } from './format'
import { ensureDynamicArrayCm } from './metadata'
import {
  clearSpillsUnder,
  finishSheet,
  restyle,
  rewriteAllFormulas,
  sheetDoc,
  stylesDoc,
  type OpResult,
} from './ops'
import {
  cellKey,
  cellName,
  MAX_COLS,
  MAX_ROWS,
  rangeName,
  requireCell,
  requireRange,
  type Range,
} from './ref'
import { richCells, setRichCell, type RichRun } from './rich-text'
import {
  ensureCell,
  ensureRow,
  findCell,
  findRow,
  unshareFormulas,
  writeCell,
  type CellContent,
} from './sheet-xml'
import { BORDER_STYLES, HORIZONTAL, VERTICAL, type BorderStyle } from './style-choices'
import { xfWithPatch, type EdgeWrite, type XfPatch } from './style-records'
import { xfWithNumFmt, type CellStyle } from './styles'
import {
  XlsxError,
  type CellValue,
  type SheetData,
  type SheetInfo,
  type Workbook,
} from './workbook'
import { all, kid, kids, make } from './xml'

/**
 * Copy and paste (Excel's Home ▸ Clipboard): a block of cells read into a
 * clipboard model (`Clip`) — values as calculated, formulas as written at
 * their source position, formats (the format record within the workbook,
 * and its look for another workbook), rich text, merged ranges — and pasted
 * as one operation: all, values, formulas or formats, transposed, skipping
 * blanks, tiled over a target that is a multiple of the block. Relative
 * references move with the paste; one pushed off the sheet reads #REF!.
 *
 * Cut and paste moves the cells: the formulas keep what they point at, and
 * every reference to a moved cell (anywhere in the workbook) follows it,
 * as in Excel. The writer here is shared with the fill (./fill.ts).
 */

export type ClipCell = {
  /** A literal, or the formula's value when copied. */
  value: CellValue
  /** The formatted display text when copied (for plain text / HTML clipboard export). */
  text?: string
  /** The formula as the file writes it, at its source position (origin + offset). */
  formula: string | null
  /** The formula is a dynamic array (spills). */
  dynamic?: boolean
  /** The source's format record (only meaningful in the same workbook; null from elsewhere). */
  style: number | null
  /** The format as a description (another workbook, or pasted from outside). */
  look: CellStyle | null
  /** A number format the text implies (pasted text like "5%"): used where the target is General. */
  implied?: string
  /** Rich text runs. */
  runs?: RichRun[]
}

export type Clip = {
  /** The workbook the cells come from (the Drive file id); null: from outside (another app). */
  book: string | null
  /** The sheet they come from (null: from outside). */
  sheet: string | null
  /** The source's top-left cell. */
  origin: { row: number; col: number }
  rows: number
  cols: number
  /** Row-major; null: an empty cell. */
  cells: Array<Array<ClipCell | null>>
  /** Merged ranges inside the block, relative to its top-left. */
  merges: Range[]
}

export type PasteMode = 'all' | 'values' | 'formulas' | 'formats'
export const PASTE_MODES = ['all', 'values', 'formulas', 'formats'] as const

export type PasteOp = {
  op: 'paste'
  sheet: string
  /** The target: its top-left cell, or a range (a multiple of the block tiles it). */
  at: string
  clip: Clip
  paste?: PasteMode
  transpose?: boolean
  skipBlanks?: boolean
  /** Move the cells (cut): only within the workbook the clip comes from. */
  cut?: boolean
}

export const MAX_CLIP_CELLS = 100_000

// ---------------------------------------------------------------------------
// Copying

/** The cells of `range` as a clip; rows hidden by an AutoFilter are left out (Excel copies the visible rows). */
export function readClip(
  ed: SheetEditor,
  sheet: string,
  range: Range,
  book: string | null,
  locale: SheetLocale = 'en',
): Clip {
  const wb = ed.wb
  const data = wb.sheet(sheet)
  const n = (range.bottom - range.top + 1) * (range.right - range.left + 1)
  if (n > MAX_CLIP_CELLS)
    throw new XlsxError(`${rangeName(range)} is ${n} cells; copy at most ${MAX_CLIP_CELLS}.`)
  const calc = ed.calc()
  const styles = wb.styles()
  const af = autoFilterOf(wb, data.info.name)
  const skipRow = (r: number) =>
    !!af &&
    af.columns.length > 0 &&
    r > af.range.top &&
    r <= af.range.bottom &&
    !!data.rows.get(r)?.hidden
  const rich = richCells(wb, data.info.name)
  const rowsKept: number[] = []
  for (let r = range.top; r <= range.bottom; r++) if (!skipRow(r)) rowsKept.push(r)
  const cells = rowsKept.map((r) => {
    const line: Array<ClipCell | null> = []
    for (let c = range.left; c <= range.right; c++) {
      const cell = data.cells.get(cellKey(r, c))
      const out = calc.cell(data.info.name, r, c)
      if (!cell && out.value === null) {
        line.push(null)
        continue
      }
      // A spilled or legacy-array cell copies its value (the formula lives in the anchor).
      const arrayFormula = cell?.formulaType === 'array' && !cell.dynamic
      const formula = cell?.formula && !arrayFormula && !cell.inArrayOf ? cell.formula : null
      const style = cell?.style ?? 0
      const look = styles.xf(style)
      const shown = displayValue(
        out.value,
        formatCode(look.numFmtId, look.numFmt, locale),
        locale,
        {
          date1904: wb.date1904,
        },
      ).text
      const clipCell: ClipCell = {
        value: out.value,
        text: shown,
        formula,
        style,
        look,
      }
      if (formula && cell?.dynamic) clipCell.dynamic = true
      const runs = rich.get(cellKey(r, c))
      if (runs && !formula) clipCell.runs = runs
      line.push(clipCell)
    }
    return line
  })
  const merges = data.merges.flatMap((m) =>
    m.top >= range.top && m.bottom <= range.bottom && m.left >= range.left && m.right <= range.right
      ? [
          {
            top: rowsKept.indexOf(m.top),
            bottom: rowsKept.indexOf(m.bottom),
            left: m.left - range.left,
            right: m.right - range.left,
          },
        ].filter((x) => x.top >= 0 && x.bottom >= 0)
      : [],
  )
  return {
    book,
    sheet: data.info.name,
    origin: { row: range.top, col: range.left },
    rows: rowsKept.length,
    cols: range.right - range.left + 1,
    cells,
    merges,
  }
}

/** The clip as another workbook gets it: format records don't carry over, their looks do. */
export function foreignClip(clip: Clip): Clip {
  return {
    ...clip,
    cells: clip.cells.map((line) => line.map((c) => (c ? { ...c, style: null } : null))),
  }
}

// ---------------------------------------------------------------------------
// Writing cells (paste and fill)

/** One target cell: its new content (undefined: unchanged), format record (undefined: unchanged) and rich text. */
export type Placement = {
  row: number
  col: number
  content?: CellContent
  style?: number
  /** A number format applied only when the cell's format is General. */
  implied?: string
  runs?: RichRun[]
}

/** Turns a look (from elsewhere) into a format record of this workbook. */
export function styleOfLook(wb: Workbook, look: CellStyle, memo: Map<string, number>): number {
  const key = JSON.stringify(look)
  const hit = memo.get(key)
  if (hit !== undefined) return hit
  const sdoc = stylesDoc(wb)
  const plain = wb.styles().xf(0)
  const patch: XfPatch = {
    font: {
      bold: look.font.bold,
      italic: look.font.italic,
      underline: look.font.underline,
      strike: look.font.strike,
      color: look.font.color,
      ...(look.font.sizePt ? { sizePt: look.font.sizePt } : {}),
      ...(look.font.name && look.font.name !== plain.font.name ? { name: look.font.name } : {}),
    },
    fill: look.fill,
    horizontal: HORIZONTAL.includes(look.horizontal as never)
      ? (look.horizontal as XfPatch['horizontal'])
      : null,
    vertical: VERTICAL.includes(look.vertical as never)
      ? (look.vertical as XfPatch['vertical'])
      : null,
    wrap: look.wrap,
  }
  const border: Record<string, EdgeWrite> = {}
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const e = look.border[side]
    border[side] = e
      ? {
          style: (BORDER_STYLES.includes(e.style as BorderStyle) ? e.style : 'thin') as BorderStyle,
          color: e.color,
        }
      : null
  }
  patch.border = border
  let xf = xfWithPatch(sdoc, 0, patch)
  if (look.numFmt && look.numFmt !== 'General') xf = xfWithNumFmt(sdoc, xf, look.numFmt)
  memo.set(key, xf)
  wb.invalidate()
  return xf
}

/**
 * Writes placements on a sheet (inside the open transaction). Refuses —
 * before any change — content inside merged cells other than their top-left
 * and parts of legacy array formulas. `area`, when given, is where merged
 * ranges are replaced by `merges` (paste of formats).
 */
export function writePlacements(
  wb: Workbook,
  info: SheetInfo,
  placements: Placement[],
  opts: { area?: Range; merges?: Range[] } = {},
): void {
  const data = wb.sheet(info.name)
  const area = opts.area
  if (area) {
    for (const m of data.merges) {
      const meets =
        m.top <= area.bottom && m.bottom >= area.top && m.left <= area.right && m.right >= area.left
      const inside =
        m.top >= area.top && m.bottom <= area.bottom && m.left >= area.left && m.right <= area.right
      if (meets && !inside)
        throw new XlsxError(
          `${info.name}!${rangeName(m)} is merged and only partly in ${rangeName(area)}; unmerge it first.`,
        )
    }
  }
  const keptMerges = area
    ? data.merges.filter(
        (m) =>
          !(
            m.top >= area.top &&
            m.bottom <= area.bottom &&
            m.left >= area.left &&
            m.right <= area.right
          ),
      )
    : data.merges
  const finalMerges = [...keptMerges, ...(opts.merges ?? [])]
  for (const p of placements) {
    if (p.row < 0 || p.col < 0 || p.row >= MAX_ROWS || p.col >= MAX_COLS)
      throw new XlsxError('The cells would go past the edge of the sheet.')
    const filled = p.content && p.content.kind !== 'clear'
    if (!filled) continue
    const where = `${info.name}!${cellName(p)}`
    const merge = finalMerges.find(
      (m) =>
        p.row >= m.top &&
        p.row <= m.bottom &&
        p.col >= m.left &&
        p.col <= m.right &&
        (m.top !== p.row || m.left !== p.col),
    )
    if (merge)
      throw new XlsxError(
        `${where} is inside the merged cells ${rangeName(merge)}; only its upper-left cell holds a value.`,
      )
  }
  const touched = new Set(placements.filter((p) => p.content).map((p) => cellKey(p.row, p.col)))
  for (const cell of data.cells.values()) {
    const arr = cell.formulaType === 'array' && !cell.dynamic ? cell.formulaRef : null
    const r =
      arr ?? (cell.inArrayOf && !isDynamicAnchor(data, cell.inArrayOf) ? cell.inArrayOf : null)
    if (!r || !touched.has(cellKey(cell.row, cell.col))) continue
    for (let row = r.top; row <= r.bottom; row++)
      for (let col = r.left; col <= r.right; col++)
        if (!touched.has(cellKey(row, col)))
          throw new XlsxError(
            `${info.name}!${cellName(cell)} is part of the array formula in ${rangeName(r)}, which can only change as a whole.`,
          )
  }
  const doc = sheetDoc(wb, info)
  if (
    placements.some((p) => p.content) &&
    all(doc, 'f').some((f) => f.getAttribute('t') === 'shared')
  )
    unshareFormulas(doc, (ref) => {
      const a = requireCell(ref)
      return data.cells.get(cellKey(a.row, a.col))?.formula ?? null
    })
  if (placements.some((p) => p.content?.kind === 'formula' && p.content.dynamicCm !== undefined)) {
    const cm = ensureDynamicArrayCm(wb)
    for (const p of placements)
      if (p.content?.kind === 'formula' && p.content.dynamicCm !== undefined)
        p.content.dynamicCm = cm
  }
  clearSpillsUnder(
    wb,
    doc,
    data,
    placements
      .filter((p) => p.content)
      .map((p) => ({ addr: { row: p.row, col: p.col }, content: p.content! })),
  )
  const styles = wb.styles()
  let sdoc: XMLDocument | null = null
  for (const p of placements) {
    let style = p.style
    const cur = data.cells.get(cellKey(p.row, p.col))?.style ?? 0
    if (p.implied && styles.xf(style ?? cur).numFmtId === 0) {
      sdoc ??= stylesDoc(wb)
      style = xfWithNumFmt(sdoc, style ?? cur, p.implied)
    }
    if (p.content) writeCell(wb, doc, p.row, p.col, p.content, style)
    else if (style !== undefined && style !== cur) restyle(wb, doc, p.row, p.col, style)
    if (p.runs && p.content?.kind === 'value') {
      const cell = ensureCell(doc, ensureRow(doc, p.row), p.row, p.col)
      setRichCell(wb, cell, p.runs)
    }
  }
  if (area) setMerges(doc, finalMerges)
  finishSheet(wb, info, doc)
}

function isDynamicAnchor(data: SheetData, r: Range): boolean {
  return data.cells.get(cellKey(r.top, r.left))?.dynamic === true
}

/** Replaces the sheet's merged ranges (mergeCells, after sheetData in schema order). */
export function setMerges(doc: XMLDocument, merges: Range[]) {
  const root = doc.documentElement!
  let el = kid(root, 'mergeCells')
  if (merges.length === 0) {
    if (el) root.removeChild(el)
    return
  }
  if (!el) {
    el = make(doc, 'mergeCells')
    insertAfterSiblings(root, el, MERGE_AFTER)
  }
  for (const k of kids(el, 'mergeCell')) el.removeChild(k)
  for (const m of merges) {
    const mc = make(doc, 'mergeCell')
    mc.setAttribute('ref', rangeName(m))
    el.appendChild(mc)
  }
  el.setAttribute('count', String(merges.length))
}

/** Elements that come before mergeCells in CT_Worksheet. */
const MERGE_AFTER = [
  'sheetPr',
  'dimension',
  'sheetViews',
  'sheetFormatPr',
  'cols',
  'sheetData',
  'sheetCalcPr',
  'sheetProtection',
  'protectedRanges',
  'scenarios',
  'autoFilter',
  'sortState',
  'dataConsolidate',
  'customSheetViews',
]

function insertAfterSiblings(root: Element, el: Element, before: string[]) {
  let last: Element | null = null
  for (const k of kids(root, undefined)) if (before.includes(k.localName)) last = k
  root.insertBefore(el, last ? last.nextSibling : root.firstChild)
}

// ---------------------------------------------------------------------------
// Pasting

/** A formula moved from one cell to another (relative references follow; off the sheet: #REF!). */
export function moveFormula(text: string, from: string, to: string): string {
  if (from === to) return text
  return translateFormulaToA1(translateFormulaToR1C1(text, from), to, { wrapEdges: false })
}

type FxToken = { type: string; value: string }
type ParsedRef = {
  workbookName?: string
  sheetName?: string
  range?: { top: number | null; left: number | null; bottom: number | null; right: number | null }
}

/**
 * Cut and paste: references (in a formula written on sheet `home`) to cells
 * inside `from` on sheet `fromSheet` follow them to sheet `toSheet`, moved by
 * `dr`/`dc`. References that only partly cover the moved block stay.
 */
export function moveRefs(
  formula: string,
  home: string,
  fromSheet: string,
  from: Range,
  toSheet: string,
  dr: number,
  dc: number,
): string {
  const key = fromSheet.toLowerCase()
  let changed = false
  const out = (tokenize(formula, { mergeRefs: true }) as FxToken[]).map((t) => {
    if (t.type !== 'range') return t.value
    const ref = parseA1Ref(t.value) as ParsedRef | undefined
    const r = ref?.range
    if (!ref || !r || ref.workbookName) return t.value
    if ((ref.sheetName || home).toLowerCase() !== key) return t.value
    if (r.top === null || r.left === null) return t.value
    const bottom = r.bottom ?? r.top
    const right = r.right ?? r.left
    if (r.top < from.top || bottom > from.bottom || r.left < from.left || right > from.right)
      return t.value
    changed = true
    const next: ParsedRef = {
      ...ref,
      range: {
        ...r,
        top: r.top + dr,
        left: r.left + dc,
        bottom: r.bottom === null ? null : r.bottom + dr,
        right: r.right === null ? null : r.right + dc,
      },
    }
    if (toSheet.toLowerCase() === home.toLowerCase()) delete next.sheetName
    else next.sheetName = toSheet
    return stringifyA1Ref(next as never)
  })
  return changed ? out.join('') : formula
}

/** References without a sheet get `sheet` (a formula moving to another sheet keeps pointing at its old one). */
export function qualifyRefs(formula: string, sheet: string): string {
  let changed = false
  const out = (tokenize(formula, { mergeRefs: true }) as FxToken[]).map((t) => {
    if (t.type !== 'range' && t.type !== 'range_beam') return t.value
    const ref = parseA1Ref(t.value) as ParsedRef | undefined
    if (!ref?.range || ref.sheetName || ref.workbookName) return t.value
    changed = true
    return stringifyA1Ref({ ...ref, sheetName: sheet } as never)
  })
  return changed ? out.join('') : formula
}

export function runPaste(wb: Workbook, op: PasteOp): OpResult {
  const info = wb.requireWorksheet(op.sheet)
  const clip = op.clip
  const mode: PasteMode = op.paste ?? 'all'
  if (!PASTE_MODES.includes(mode)) throw new XlsxError(`“${mode}” is not a way to paste.`)
  if (clip.rows < 1 || clip.cols < 1 || clip.cells.length !== clip.rows)
    throw new XlsxError('There is nothing to paste.')
  if (clip.rows * clip.cols > MAX_CLIP_CELLS)
    throw new XlsxError(`Paste at most ${MAX_CLIP_CELLS} cells at a time.`)
  if (op.cut && (mode !== 'all' || op.transpose || op.skipBlanks))
    throw new XlsxError('Cut cells can only be pasted as they are (no paste special).')
  if (op.cut && !clip.sheet) throw new XlsxError('Only cells cut from this workbook can be moved.')
  const target = requireRange(op.at)
  const R = op.transpose ? clip.cols : clip.rows
  const C = op.transpose ? clip.rows : clip.cols
  const th = target.bottom - target.top + 1
  const tw = target.right - target.left + 1
  const single = th === 1 && tw === 1
  // A single cell, or a block the same size: paste once; a multiple of the block: tile (as Excel).
  let tilesDown = 1
  let tilesAcross = 1
  if (!single && !(th === R && tw === C)) {
    if (op.cut || th % R !== 0 || tw % C !== 0)
      throw new XlsxError(
        `The copied block is ${R}×${C} cells and ${rangeName(target)} is ${th}×${tw}: paste into one cell or a range of the same size (or a multiple of it).`,
      )
    tilesDown = th / R
    tilesAcross = tw / C
  }
  if (target.top + R * tilesDown > MAX_ROWS || target.left + C * tilesAcross > MAX_COLS)
    throw new XlsxError('The pasted cells would go past the edge of the sheet.')
  if (R * C * tilesDown * tilesAcross > MAX_CLIP_CELLS)
    throw new XlsxError(`Paste at most ${MAX_CLIP_CELLS} cells at a time.`)

  const memo = new Map<string, number>()
  const placements: Placement[] = []
  const merges: Range[] = []
  for (let ti = 0; ti < tilesDown; ti++)
    for (let tj = 0; tj < tilesAcross; tj++) {
      const top = target.top + ti * R
      const left = target.left + tj * C
      for (let i = 0; i < clip.rows; i++)
        for (let j = 0; j < clip.cols; j++) {
          const src = clip.cells[i]?.[j] ?? null
          const blank = !src || (src.value === null && src.formula === null)
          if (op.skipBlanks && blank) continue
          const row = top + (op.transpose ? j : i)
          const col = left + (op.transpose ? i : j)
          const p: Placement = { row, col }
          if (mode !== 'formats') {
            p.content = contentOf(
              wb,
              src,
              mode,
              op.cut ? null : { i, j, clip, row, col },
              op.cut ? clip.sheet : null,
              info.name,
            )
            if (src?.runs && mode === 'all' && p.content.kind === 'value') p.runs = src.runs
          }
          if (mode === 'all' || mode === 'formats') {
            const style = styleOf(wb, src, memo)
            if (style !== undefined) p.style = style
            if (src?.implied && style === undefined) p.implied = src.implied
          } else if (src?.implied && mode !== 'values') p.implied = src.implied
          placements.push(p)
        }
      for (const m of clip.merges)
        merges.push(
          op.transpose
            ? {
                top: top + m.left,
                bottom: top + m.right,
                left: left + m.top,
                right: left + m.bottom,
              }
            : {
                top: top + m.top,
                bottom: top + m.bottom,
                left: left + m.left,
                right: left + m.right,
              },
        )
    }
  const area: Range = {
    top: target.top,
    left: target.left,
    bottom: target.top + R * tilesDown - 1,
    right: target.left + C * tilesAcross - 1,
  }
  const withMerges = mode === 'all' || mode === 'formats'
  if (op.cut) return cutPaste(wb, info, op, placements, merges, area)
  writePlacements(wb, info, placements, withMerges ? { area, merges } : {})
  return { sheets: [info.name] }
}

function contentOf(
  wb: Workbook,
  src: ClipCell | null,
  mode: PasteMode,
  move: { i: number; j: number; clip: Clip; row: number; col: number } | null,
  cutFrom: string | null = null,
  cutTo = '',
): CellContent {
  if (!src) return { kind: 'clear' }
  if (src.formula !== null && mode !== 'values') {
    let formula = src.formula
    if (!move && cutFrom && cutFrom.toLowerCase() !== cutTo.toLowerCase())
      formula = qualifyRefs(formula, cutFrom)
    if (move) {
      const from = cellName({
        row: move.clip.origin.row + move.i,
        col: move.clip.origin.col + move.j,
      })
      formula = moveFormula(formula, from, cellName({ row: move.row, col: move.col }))
    }
    return src.dynamic || needsDynamicArray(formula, wb)
      ? { kind: 'formula', formula, dynamicCm: 0 }
      : { kind: 'formula', formula }
  }
  if (src.value === null || src.value === '') return { kind: 'clear' }
  return { kind: 'value', value: src.value }
}

function styleOf(
  wb: Workbook,
  src: ClipCell | null,
  memo: Map<string, number>,
): number | undefined {
  if (!src) return 0
  if (src.style !== null && src.style < wb.styles().count) return src.style
  if (src.look) return styleOfLook(wb, src.look, memo)
  return undefined
}

/** Cut and paste: the cells move, references to them follow, the source is left empty. */
function cutPaste(
  wb: Workbook,
  info: SheetInfo,
  op: PasteOp,
  placements: Placement[],
  merges: Range[],
  area: Range,
): OpResult {
  const clip = op.clip
  const srcInfo = wb.requireWorksheet(clip.sheet!)
  const from: Range = {
    top: clip.origin.row,
    left: clip.origin.col,
    bottom: clip.origin.row + clip.rows - 1,
    right: clip.origin.col + clip.cols - 1,
  }
  const dr = area.top - from.top
  const dc = area.left - from.left
  // Shared formulas everywhere are written out per cell first (their references move unevenly).
  for (const s of wb.sheets()) {
    if (s.kind !== 'worksheet') continue
    if (!all(wb.pkg.xml(s.part), 'f').some((f) => f.getAttribute('t') === 'shared')) continue
    const sd = wb.sheet(s.name)
    unshareFormulas(sheetDoc(wb, s), (ref) => {
      const a = requireCell(ref)
      return sd.cells.get(cellKey(a.row, a.col))?.formula ?? null
    })
    finishSheet(wb, s, sheetDoc(wb, s))
  }
  // The source is emptied (content, format, merges) where the target doesn't cover it.
  const srcData = wb.sheet(srcInfo.name)
  const sameSheet = srcInfo.part === info.part
  const inArea = (r: number, c: number) =>
    sameSheet && r >= area.top && r <= area.bottom && c >= area.left && c <= area.right
  const srcDoc = sheetDoc(wb, srcInfo)
  for (const cell of [...srcData.cells.values()]) {
    if (
      cell.row < from.top ||
      cell.row > from.bottom ||
      cell.col < from.left ||
      cell.col > from.right
    )
      continue
    if (inArea(cell.row, cell.col)) continue
    const rowEl = findRow(srcDoc, cell.row)
    const el = rowEl ? findCell(rowEl, cell.col) : null
    if (el) el.removeAttribute('s')
    writeCell(wb, srcDoc, cell.row, cell.col, { kind: 'clear' }, 0)
  }
  const srcMerges = srcData.merges.filter(
    (m) =>
      !(
        m.top >= from.top &&
        m.bottom <= from.bottom &&
        m.left >= from.left &&
        m.right <= from.right
      ),
  )
  setMerges(srcDoc, srcMerges)
  finishSheet(wb, srcInfo, srcDoc)
  writePlacements(wb, info, placements, { area, merges })
  rewriteAllFormulas(wb, (f, home) => moveRefs(f, home, srcInfo.name, from, info.name, dr, dc))
  return { sheets: sameSheet ? [info.name] : [srcInfo.name, info.name] }
}
