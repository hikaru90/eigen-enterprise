import type { SheetEditor } from './editor'
import { parseA1Ref } from '@borgar/fx/xlsx'
import { needsDynamicArray } from './calc-static'
import { displayValue, formatCode, type SheetLocale } from './format'
import { ensureDynamicArrayCm } from './metadata'
import {
  clearSpillsUnder,
  finishSheet,
  sheetDoc,
  toFileFormula,
  toShownFormula,
  type OpResult,
} from './ops'
import { cellKey, cellName, MAX_COLS, MAX_ROWS, parseRange, requireCell, type Range } from './ref'
import { unshareFormulas, writeCell, type CellContent } from './sheet-xml'
import { isErrorValue, XlsxError, type CellData, type Workbook } from './workbook'
import { all } from './xml'

/**
 * Find and replace (Excel's Ctrl+F / Ctrl+H): search the cells of a sheet or
 * the whole workbook, by row, for text in their formulas (the content as
 * typed: a formula with "=", a value as entered) or their values (what the
 * cells show); match case and match entire cell contents as options. As in
 * Excel, `*` stands for any characters, `?` for one, `~` makes the next one
 * literal; there are no regular expressions.
 *
 * Replace works on the content (formulas and literal text/numbers): a
 * formula that no longer reads is refused naming its cell, a number whose
 * text no longer is a number becomes text. Cells inside arrays and spills
 * are not replaced.
 */

export type FindOptions = {
  query: string
  /** One sheet; null: every sheet of the workbook. */
  sheet: string | null
  matchCase?: boolean
  wholeCell?: boolean
  lookIn?: 'formulas' | 'values'
}

export type FindHit = { sheet: string; ref: string; text: string }

export const MAX_FIND_HITS = 10_000

/** Excel's wildcard pattern as a regular expression over the searched text. */
export function wildcard(
  query: string,
  opts: { matchCase?: boolean; wholeCell?: boolean },
): RegExp {
  let src = ''
  for (let i = 0; i < query.length; i++) {
    const ch = query[i]!
    if (ch === '~' && i + 1 < query.length) {
      src += escapeRe(query[++i]!)
      continue
    }
    if (ch === '*') src += '[\\s\\S]*?'
    else if (ch === '?') src += '[\\s\\S]'
    else src += escapeRe(ch)
  }
  if (opts.wholeCell) src = `^(?:${src})$`
  return new RegExp(src, opts.matchCase ? 'g' : 'gi')
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The text a cell is searched in. */
function searchText(
  ed: SheetEditor,
  sheet: string,
  cell: CellData,
  lookIn: 'formulas' | 'values',
  locale: SheetLocale,
): string {
  const wb = ed.wb
  if (lookIn === 'formulas') return contentText(wb, cell)
  const out = ed.calc().cell(sheet, cell.row, cell.col)
  const st = wb.styles().xf(cell.style)
  return displayValue(out.value, formatCode(st.numFmtId, st.numFmt, locale), locale, {
    date1904: wb.date1904,
  }).text
}

/** A cell's content as typed (Excel's "Formulas"): "=A1+1", "12.5", "text", "TRUE". */
function contentText(_wb: Workbook, cell: CellData): string {
  if (cell.formula !== null) return `=${toShownFormula(cell.formula)}`
  const v = cell.value
  if (v === null) return ''
  if (isErrorValue(v)) return v.error
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return String(v)
}

/** Every cell that matches, sheet by sheet (in tab order), row by row. */
export function findCells(
  ed: SheetEditor,
  opts: FindOptions,
  locale: SheetLocale = 'en',
): FindHit[] {
  if (opts.query === '') throw new XlsxError('Say what to find.')
  const lookIn = opts.lookIn ?? 'formulas'
  const re = wildcard(opts.query, opts)
  const sheets = opts.sheet
    ? [ed.wb.requireWorksheet(opts.sheet)]
    : ed.wb.sheets().filter((s) => s.kind === 'worksheet')
  const hits: FindHit[] = []
  for (const s of sheets) {
    const cells = [...ed.wb.sheet(s.name).cells.values()].sort((a, b) =>
      a.row === b.row ? a.col - b.col : a.row - b.row,
    )
    for (const cell of cells) {
      if (cell.value === null && cell.formula === null) continue
      const text = searchText(ed, s.name, cell, lookIn, locale)
      re.lastIndex = 0
      if (!re.test(text)) continue
      hits.push({ sheet: s.name, ref: cellName(cell), text })
      if (hits.length >= MAX_FIND_HITS) return hits
    }
  }
  return hits
}

export type ReplaceOp = {
  op: 'replace'
  find: string
  replace: string
  /** One sheet; null: every sheet. */
  sheet: string | null
  matchCase?: boolean
  wholeCell?: boolean
  /** Only these cells (Excel's Replace, one hit); omitted: all matches (Replace All). */
  cells?: Array<{ sheet: string; ref: string }>
}

/** The content after replacing, or null when nothing in it matches. */
export function replacedText(
  text: string,
  op: Pick<ReplaceOp, 'find' | 'replace' | 'matchCase' | 'wholeCell'>,
): string | null {
  const re = wildcard(op.find, op)
  re.lastIndex = 0
  if (!re.test(text)) return null
  re.lastIndex = 0
  // Literal replacement text (no $1 patterns), as Excel.
  return text.replace(re, () => op.replace)
}

export function runReplace(wb: Workbook, op: ReplaceOp): OpResult {
  if (op.find === '') throw new XlsxError('Say what to replace.')
  const only = op.cells
    ? new Set(
        op.cells.map((c) => `${c.sheet.toLowerCase()}!${c.ref.toUpperCase().replace(/\$/g, '')}`),
      )
    : null
  const sheets = op.sheet
    ? [wb.requireWorksheet(op.sheet)]
    : wb.sheets().filter((s) => s.kind === 'worksheet')
  const changed: string[] = []
  for (const info of sheets) {
    const data = wb.sheet(info.name)
    const plans: Array<{ cell: CellData; text: string }> = []
    for (const cell of data.cells.values()) {
      if (cell.value === null && cell.formula === null) continue
      if (cell.inArrayOf || (cell.formulaType === 'array' && !cell.dynamic)) continue
      if (only && !only.has(`${info.name.toLowerCase()}!${cellName(cell)}`)) continue
      const next = replacedText(contentText(wb, cell), op)
      if (next === null) continue
      plans.push({ cell, text: next })
    }
    if (plans.length === 0) continue
    const doc = sheetDoc(wb, info)
    if (all(doc, 'f').some((f) => f.getAttribute('t') === 'shared'))
      unshareFormulas(doc, (ref) => {
        const a = requireCell(ref)
        return data.cells.get(cellKey(a.row, a.col))?.formula ?? null
      })
    const planned: Array<{ addr: { row: number; col: number }; content: CellContent }> = []
    for (const { cell, text } of plans) {
      const where = `${info.name}!${cellName(cell)}`
      let content: CellContent
      if (cell.formula !== null || text.startsWith('=')) {
        if (text.startsWith('=') && text.length > 1) {
          const formula = toFileFormula(text, where)
          content = needsDynamicArray(formula, wb)
            ? { kind: 'formula', formula, dynamicCm: 0 }
            : { kind: 'formula', formula }
        } else content = textContent(text)
      } else if (typeof cell.value === 'number') {
        const n = Number(text)
        content =
          text.trim() !== '' && Number.isFinite(n) ? { kind: 'value', value: n } : textContent(text)
      } else if (typeof cell.value === 'boolean') {
        const u = text.toUpperCase()
        content =
          u === 'TRUE' || u === 'FALSE' ? { kind: 'value', value: u === 'TRUE' } : textContent(text)
      } else content = textContent(text)
      planned.push({ addr: { row: cell.row, col: cell.col }, content })
    }
    if (planned.some((p) => p.content.kind === 'formula' && p.content.dynamicCm !== undefined)) {
      const cm = ensureDynamicArrayCm(wb)
      for (const p of planned)
        if (p.content.kind === 'formula' && p.content.dynamicCm !== undefined)
          p.content.dynamicCm = cm
    }
    clearSpillsUnder(wb, doc, data, planned)
    for (const p of planned) writeCell(wb, doc, p.addr.row, p.addr.col, p.content)
    finishSheet(wb, info, doc)
    changed.push(info.name)
  }
  return { sheets: changed }
}

const textContent = (text: string) =>
  text === '' ? ({ kind: 'clear' } as const) : ({ kind: 'value', value: text } as const)

// ---------------------------------------------------------------------------
// Go To (F5 / Name Box)

export type GoToTarget = { sheet: string; range: Range; name?: string }

type ParsedA1 = {
  workbookName?: string
  sheetName?: string
  range?: { top: number | null; left: number | null; bottom: number | null; right: number | null }
}

/** Resolves a cell, range, sheet-qualified reference (`Sheet2!B3:D5`) or defined name (`Costs`) to jump to. */
export function resolveGoTo(wb: Workbook, activeSheet: string, input: string): GoToTarget {
  const raw = input.trim()
  if (!raw) throw new XlsxError('Enter a cell reference (like B12 or Sheet2!A1) or defined name.')
  const direct = parseRangeOrBeam(wb, activeSheet, raw)
  if (direct) return direct
  const activeIdx = wb.findSheet(activeSheet)?.index
  const key = raw.toLowerCase()
  const names = wb.definedNames()
  const def =
    names.find((n) => n.localSheet === activeIdx && n.name.toLowerCase() === key) ??
    names.find((n) => n.localSheet === null && n.name.toLowerCase() === key)
  if (def) {
    const resolved = parseRangeOrBeam(
      wb,
      def.localSheet !== null ? (wb.sheets()[def.localSheet]?.name ?? activeSheet) : activeSheet,
      def.formula.replace(/^=/, ''),
    )
    if (resolved) return { ...resolved, name: def.name }
    throw new XlsxError(`The defined name “${def.name}” does not refer to a range of cells.`)
  }
  throw new XlsxError(`“${raw}” is not a valid cell reference or defined name.`)
}

function parseRangeOrBeam(wb: Workbook, fallbackSheet: string, text: string): GoToTarget | null {
  const plain = parseRange(text)
  if (plain) {
    wb.requireWorksheet(fallbackSheet)
    return { sheet: fallbackSheet, range: plain }
  }
  const ref = parseA1Ref(text) as ParsedA1 | undefined
  if (!ref?.range || ref.workbookName) return null
  const r = ref.range
  const targetSheet = ref.sheetName
    ? wb.requireWorksheet(ref.sheetName).name
    : wb.requireWorksheet(fallbackSheet).name
  if (r.top === null && r.left === null) return null
  const top = r.top ?? 0
  const bottom = r.bottom ?? (r.top === null ? MAX_ROWS - 1 : top)
  const left = r.left ?? 0
  const right = r.right ?? (r.left === null ? MAX_COLS - 1 : left)
  if (top < 0 || bottom >= MAX_ROWS || left < 0 || right >= MAX_COLS) return null
  return {
    sheet: targetSheet,
    range: {
      top: Math.min(top, bottom),
      bottom: Math.max(top, bottom),
      left: Math.min(left, right),
      right: Math.max(left, right),
    },
  }
}

/** Named ranges in the workbook that resolve to a cell range (for the Go To list). */
export function listGoToNames(
  wb: Workbook,
  activeSheet: string,
): Array<GoToTarget & { name: string }> {
  const activeIdx = wb.findSheet(activeSheet)?.index
  const out: Array<GoToTarget & { name: string }> = []
  for (const n of wb.definedNames()) {
    if (n.hidden) continue
    if (n.localSheet !== null && n.localSheet !== activeIdx) continue
    const fallback =
      n.localSheet !== null ? (wb.sheets()[n.localSheet]?.name ?? activeSheet) : activeSheet
    const t = parseRangeOrBeam(wb, fallback, n.formula.replace(/^=/, ''))
    if (t) out.push({ ...t, name: n.name })
  }
  return out
}
