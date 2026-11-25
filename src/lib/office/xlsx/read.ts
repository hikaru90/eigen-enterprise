import type { SheetEditor } from './editor'
import { displayValue, formatCode, type SheetLocale } from './format'
import { toShownFormula } from './ops'
import { cellKey, cellName, rangeName, requireRange, type Range } from './ref'
import { isErrorValue, XlsxError, type CellValue } from './workbook'

/**
 * Reading a workbook as data (drive.sheet_read, the agent's text): the
 * sheets with their used ranges, and the cells of a range with their values
 * (calculated), formulas, shown text and number format.
 */

export type SheetSummary = { name: string; kind: string; hidden: boolean; used: string | null }

export type ReadCell = {
  ref: string
  /** The value: a number, text, true/false, or { error: "#DIV/0!" }. */
  value: CellValue
  /** The formula with "=", when the cell has one. */
  formula?: string
  /** As the cell shows it (its number format applied). */
  text: string
  /** The number format code, when not General. */
  format?: string
  /** The value is Excel's last calculated one: this editor can't calculate the formula (why). */
  kept?: string
}

export function sheetSummaries(ed: SheetEditor): SheetSummary[] {
  return ed.wb.sheets().map((s) => {
    const used = s.kind === 'worksheet' ? usedRange(ed, s.name) : null
    return {
      name: s.name,
      kind: s.kind === 'worksheet' ? 'sheet' : s.kind,
      hidden: s.state !== 'visible',
      used: used ? rangeName(used) : null,
    }
  })
}

export function usedRange(ed: SheetEditor, sheet: string): Range | null {
  const d = ed.wb.sheet(sheet)
  return d.maxRow < 0 ? null : { top: 0, left: 0, bottom: d.maxRow, right: d.maxCol }
}

/** The non-empty cells of `range` (null: the used range), row by row. At most `max` cells; a larger range is refused, never cut. */
export function readCells(
  ed: SheetEditor,
  sheet: string,
  rangeText: string | null,
  locale: SheetLocale,
  max: number,
): { range: string | null; cells: ReadCell[] } {
  const info = ed.wb.requireWorksheet(sheet)
  const range = rangeText ? requireRange(rangeText) : usedRange(ed, info.name)
  if (!range) return { range: null, cells: [] }
  const data = ed.wb.sheet(info.name)
  const styles = ed.wb.styles()
  const calc = ed.calc()
  const picked = [...data.cells.values()]
    .filter(
      (c) =>
        c.row >= range.top &&
        c.row <= range.bottom &&
        c.col >= range.left &&
        c.col <= range.right &&
        (c.value !== null || c.formula !== null),
    )
    .sort((a, b) => a.row - b.row || a.col - b.col)
  if (picked.length > max)
    throw new XlsxError(
      `${info.name}!${rangeName(range)} has ${picked.length} filled cells; read at most ${max} at a time (ask for a smaller range).`,
    )
  return {
    range: rangeName(range),
    cells: picked.map((c) => {
      const out = calc.cell(info.name, c.row, c.col)
      const st = styles.xf(c.style)
      const code = formatCode(st.numFmtId, st.numFmt, locale)
      const cell: ReadCell = {
        ref: cellName(c),
        value: out.value,
        text: displayValue(out.value, code, locale, { date1904: ed.wb.date1904 }).text,
      }
      if (c.formula !== null) cell.formula = `=${toShownFormula(c.formula)}`
      if (st.numFmt !== 'General') cell.format = st.numFmt
      if (out.kept) cell.kept = out.reason
      return cell
    }),
  }
}

/** The shown text of every cell of `range` (null: the used range) as rows, for tables. */
export function sheetValues(
  ed: SheetEditor,
  sheet: string,
  rangeText: string | null,
  locale: SheetLocale,
): { range: string | null; rows: string[][] } {
  const info = ed.wb.requireWorksheet(sheet)
  const range = rangeText ? requireRange(rangeText) : usedRange(ed, info.name)
  if (!range) return { range: null, rows: [] }
  const data = ed.wb.sheet(info.name)
  const styles = ed.wb.styles()
  const calc = ed.calc()
  const rows: string[][] = []
  for (let r = range.top; r <= range.bottom; r++) {
    const row: string[] = []
    for (let c = range.left; c <= range.right; c++) {
      const cell = data.cells.get(cellKey(r, c))
      if (!cell) {
        row.push('')
        continue
      }
      const v = calc.cell(info.name, r, c).value
      const st = styles.xf(cell.style)
      row.push(
        isErrorValue(v)
          ? v.error
          : displayValue(v, formatCode(st.numFmtId, st.numFmt, locale), locale, {
              date1904: ed.wb.date1904,
            }).text,
      )
    }
    rows.push(row)
  }
  return { range: rangeName(range), rows }
}
