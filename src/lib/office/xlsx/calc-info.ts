import { err, isAreas, isRef, Unsupported, type RefVal, type Val } from './calc-values'
import { toShownText } from './formula-text'
import { cellKey, colName } from './ref'
import { isErrorValue, type CellValue, type Workbook } from './workbook'
import { kid, kids } from './xml'

/**
 * Functions about the workbook rather than values (Microsoft's function
 * reference): CELL and INFO where the answer is in the file (what depends on
 * the computer, the selection or the file's path is refused), SHEET, SHEETS,
 * ISFORMULA, FORMULATEXT, TRIMRANGE.
 */

/** CELL("format") for the built-in number formats (by numFmtId, as Excel's en-US table maps them). */
const FORMAT_BY_ID: Record<number, string> = {
  0: 'G',
  1: 'F0',
  2: 'F2',
  3: ',0',
  4: ',2',
  5: 'C0',
  6: 'C0-',
  7: 'C2',
  8: 'C2-',
  9: 'P0',
  10: 'P2',
  11: 'S2',
  12: 'G',
  13: 'G',
  14: 'D4',
  15: 'D1',
  16: 'D2',
  17: 'D3',
  18: 'D7',
  19: 'D6',
  20: 'D9',
  21: 'D8',
  22: 'D4',
}

/** The same table by format code, for a custom numFmt written with one of these codes. */
const FORMAT_BY_CODE: Record<string, string> = {
  general: 'G',
  '0': 'F0',
  '#,##0': ',0',
  '0.00': 'F2',
  '#,##0.00': ',2',
  '$#,##0_);($#,##0)': 'C0',
  '$#,##0_);[red]($#,##0)': 'C0-',
  '$#,##0.00_);($#,##0.00)': 'C2',
  '$#,##0.00_);[red]($#,##0.00)': 'C2-',
  '0%': 'P0',
  '0.00%': 'P2',
  '0.00e+00': 'S2',
  '# ?/?': 'G',
  '# ??/??': 'G',
  'm/d/yy': 'D4',
  'm/d/yy h:mm': 'D4',
  'mm/dd/yy': 'D4',
  'd-mmm-yy': 'D1',
  'dd-mmm-yy': 'D1',
  'd-mmm': 'D2',
  'dd-mmm': 'D2',
  'mmm-yy': 'D3',
  'mm/dd': 'D5',
  'h:mm am/pm': 'D7',
  'h:mm:ss am/pm': 'D6',
  'h:mm': 'D9',
  'h:mm:ss': 'D8',
}

/** The sections of a format code (split on ; outside quotes and brackets). */
function sections(code: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let bracket = false
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!
    if (ch === '\\' && !quoted) {
      cur += ch + (code[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '[') bracket = true
    else if (!quoted && ch === ']') bracket = false
    if (ch === ';' && !quoted && !bracket) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/** A section's text outside quotes, escapes and brackets. */
const bare = (s: string) =>
  s.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '')

const COLORS = /\[(black|blue|cyan|green|magenta|red|white|yellow|color\s*\d+)\]/i

function numberFormat(wb: Workbook, style: number): { id: number; code: string } {
  const st = wb.styles().xf(style)
  return { id: st.numFmtId, code: st.numFmt }
}

function colorOf(code: string): number {
  const s = sections(code)
  return s.length > 1 && COLORS.test(s[1]!) ? 1 : 0
}

function parenthesesOf(code: string): number {
  const first = bare(sections(code)[0] ?? '')
  return first.includes('(') ? 1 : 0
}

function formatOf(wb: Workbook, style: number): string {
  const { id, code } = numberFormat(wb, style)
  // Built-in formats by id (custom formats start at 164), else a custom code from the table.
  const known = (id < 164 ? FORMAT_BY_ID[id] : undefined) ?? FORMAT_BY_CODE[code.toLowerCase()]
  if (known === undefined)
    throw new Unsupported(`CELL("format") of the number format “${code}” (not in Excel's table)`)
  return known
}

/** The xf element of a cell format (for its protection). */
function xfElement(wb: Workbook, style: number): Element | null {
  const part = wb.stylesPart()
  if (!part) return null
  const xfs = kid(wb.pkg.xml(part).documentElement!, 'cellXfs')
  return xfs ? (kids(xfs, 'xf')[style] ?? null) : null
}

function lockedOf(wb: Workbook, style: number): number {
  const p = xfElement(wb, style)
  const prot = p ? kid(p, 'protection') : null
  const locked = prot?.getAttribute('locked')
  return locked === '0' || locked === 'false' ? 0 : 1
}

export type CellInfoDeps = {
  wb: Workbook
  /** The formula's sheet (CELL of another sheet's cell names the workbook file, which is unknown). */
  home: string
  value(sheet: string, row: number, col: number): CellValue
}

export function cellInfo(deps: CellInfoDeps, typeV: CellValue, refV: Val | undefined): Val {
  if (isErrorValue(typeV)) return typeV
  if (typeof typeV !== 'string') return err('#VALUE!')
  const type = typeV.toLowerCase()
  if (refV === undefined) throw new Unsupported(`CELL("${typeV}") without a reference (it reads the selection)`)
  if (isErrorValue(refV)) return refV
  if (isAreas(refV)) throw new Unsupported('CELL over a union of ranges')
  if (!isRef(refV)) return err('#VALUE!')
  const { sheet, top: row, left: col } = refV.ref
  const { wb } = deps
  const data = wb.sheet(sheet).cells.get(cellKey(row, col))
  const style = data?.style ?? 0
  switch (type) {
    case 'address':
      if (sheet.toLowerCase() !== deps.home.toLowerCase())
        throw new Unsupported('CELL("address") of another sheet (it names the workbook file)')
      return `$${colName(col)}$${row + 1}`
    case 'col':
      return col + 1
    case 'row':
      return row + 1
    case 'contents':
      return deps.value(sheet, row, col)
    case 'type': {
      const v = deps.value(sheet, row, col)
      if (v === null) return 'b'
      return typeof v === 'string' && !data?.formula ? 'l' : 'v'
    }
    case 'format':
      return formatOf(wb, style)
    case 'color':
      return colorOf(numberFormat(wb, style).code)
    case 'parentheses':
      return parenthesesOf(numberFormat(wb, style).code)
    case 'protect':
      return lockedOf(wb, style)
    case 'prefix': {
      const v = deps.value(sheet, row, col)
      if (typeof v !== 'string' || data?.formula) return ''
      const h = wb.styles().xf(style).horizontal
      if (h === 'left') return "'"
      if (h === 'right') return '"'
      if (h === 'center') return '^'
      if (h === 'fill') return '\\'
      throw new Unsupported(`CELL("prefix") of text aligned “${h ?? 'general'}”`)
    }
    case 'filename':
    case 'width':
      throw new Unsupported(`CELL("${typeV}") (it depends on the file's location or the screen font)`)
    default:
      return err('#VALUE!')
  }
}

export function infoValue(wb: Workbook, typeV: CellValue): CellValue {
  if (isErrorValue(typeV)) return typeV
  if (typeof typeV !== 'string') return err('#VALUE!')
  const type = typeV.toLowerCase()
  if (type === 'recalc') {
    const calcPr = kid(wb.pkg.xml(wb.part).documentElement!, 'calcPr')
    const mode = calcPr?.getAttribute('calcMode') ?? 'auto'
    if (mode === 'auto') return 'Automatic'
    if (mode === 'manual') return 'Manual'
    throw new Unsupported(`INFO("recalc") with calculation mode ${mode}`)
  }
  if (['directory', 'numfile', 'origin', 'osversion', 'release', 'system', 'memavail', 'memused', 'totmem'].includes(type))
    throw new Unsupported(`INFO("${typeV}") (it describes the computer running Excel)`)
  return err('#VALUE!')
}

/** SHEET(): the sheet's number among all sheets (hidden and chart sheets too). */
export function sheetNumber(wb: Workbook, home: string, v: Val | undefined): CellValue {
  const index = (name: string) => {
    const i = wb.sheets().findIndex((s) => s.name.toLowerCase() === name.toLowerCase())
    return i < 0 ? null : i + 1
  }
  if (v === undefined) return index(home) ?? err('#REF!')
  if (isErrorValue(v)) return v
  if (isRef(v)) return index(v.ref.sheet) ?? err('#REF!')
  if (isAreas(v)) return index(v.areas[0]!.sheet) ?? err('#REF!')
  if (typeof v === 'string') return index(v) ?? err('#N/A')
  throw new Unsupported('SHEET of a value that is neither a reference nor a sheet name')
}

/** SHEETS(): how many sheets (a reference on one sheet: 1). */
export function sheetCount(wb: Workbook, v: Val | undefined): CellValue {
  if (v === undefined) return wb.sheets().length
  if (isErrorValue(v)) return v
  if (isRef(v) || isAreas(v)) return 1
  return err('#VALUE!')
}

export type FormulaDeps = {
  wb: Workbook
  /** The anchor of a legacy array formula whose range holds this cell, if any. */
  legacyAnchor(sheet: string, row: number, col: number): { row: number; col: number } | null
}

function formulaAtCell(deps: FormulaDeps, sheet: string, row: number, col: number): { text: string; legacy: boolean } | null {
  const cells = deps.wb.sheet(sheet).cells
  const own = cells.get(cellKey(row, col))
  if (own?.formula) {
    const legacy = own.formulaType === 'array' && !own.dynamic
    return { text: own.formula, legacy }
  }
  const a = deps.legacyAnchor(sheet, row, col)
  if (a) {
    const anchor = cells.get(cellKey(a.row, a.col))
    if (anchor?.formula) return { text: anchor.formula, legacy: true }
  }
  return null
}

function formulaOver(
  deps: FormulaDeps,
  v: Val,
  map: (f: { text: string; legacy: boolean } | null) => CellValue,
): CellValue | Val {
  if (isErrorValue(v)) return v
  if (isAreas(v)) throw new Unsupported('ISFORMULA/FORMULATEXT over a union of ranges')
  if (!isRef(v)) return err('#VALUE!')
  const { sheet, top, left, bottom, right } = (v as RefVal).ref
  if (top === bottom && left === right) return map(formulaAtCell(deps, sheet, top, left))
  const out: CellValue[][] = []
  for (let r = top; r <= bottom; r++) {
    const row: CellValue[] = []
    for (let c = left; c <= right; c++) row.push(map(formulaAtCell(deps, sheet, r, c)))
    out.push(row)
  }
  return out
}

export function isFormula(deps: FormulaDeps, v: Val): Val {
  return formulaOver(deps, v, (f) => f !== null)
}

export function formulaText(deps: FormulaDeps, v: Val): Val {
  return formulaOver(deps, v, (f) => {
    if (!f) return err('#N/A')
    const shown = `=${toShownText(f.text)}`
    return f.legacy ? `{${shown}}` : shown
  })
}

/** TRIMRANGE(range, [trim_rows], [trim_cols]): the reference without its empty outer rows and columns. */
export function trimRange(
  v: Val,
  rowsMode: number,
  colsMode: number,
  empty: (sheet: string, row: number, col: number) => boolean,
): Val {
  if (isErrorValue(v)) return v
  if (!isRef(v)) throw new Unsupported('TRIMRANGE of an array (only references are trimmed here)')
  for (const m of [rowsMode, colsMode]) if (![0, 1, 2, 3].includes(m)) return err('#VALUE!')
  const r = { ...v.ref }
  const rowEmpty = (row: number) => {
    for (let c = r.left; c <= r.right; c++) if (!empty(r.sheet, row, c)) return false
    return true
  }
  const colEmpty = (col: number) => {
    for (let x = r.top; x <= r.bottom; x++) if (!empty(r.sheet, x, col)) return false
    return true
  }
  const leading = (m: number) => m === 1 || m === 3
  const trailing = (m: number) => m === 2 || m === 3
  let any = false
  for (let x = r.top; x <= r.bottom && !any; x++) if (!rowEmpty(x)) any = true
  if (!any) throw new Unsupported('TRIMRANGE of a range with nothing in it')
  if (leading(rowsMode)) while (r.top < r.bottom && rowEmpty(r.top)) r.top++
  if (trailing(rowsMode)) while (r.bottom > r.top && rowEmpty(r.bottom)) r.bottom--
  if (leading(colsMode)) while (r.left < r.right && colEmpty(r.left)) r.left++
  if (trailing(colsMode)) while (r.right > r.left && colEmpty(r.right)) r.right--
  return { ref: r }
}
