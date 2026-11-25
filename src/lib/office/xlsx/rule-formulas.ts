import type { Calc } from './calc'
import { parseA1Ref, tokenize } from '@borgar/fx/xlsx'
import { truthy } from './calc-values'
import { cellName, type Range } from './ref'
import { translateFormula } from './shift'
import { isErrorValue, type CellValue, type Workbook } from './workbook'

/**
 * Formulas of conditional formats and validations (ECMA-376 Part 1
 * §18.3.1.10, §18.3.1.32): written relative to the top-left cell of the
 * rule's first range, they are evaluated for each cell as if moved there —
 * the same translation as a shared formula — by our calculator (./calc.ts).
 */

export type RuleCalc = {
  /** The formula's value for cell (row, col), anchored at `anchor`. */
  value(formula: string, anchor: { row: number; col: number }, row: number, col: number): CellValue
  /** The formula as a condition (TRUE or a non-zero number; text, errors and blanks are false). */
  test(formula: string, anchor: { row: number; col: number }, row: number, col: number): boolean
}

export function ruleCalc(calc: Calc, sheet: string): RuleCalc {
  const memo = new Map<string, CellValue>()
  const value = (
    formula: string,
    anchor: { row: number; col: number },
    row: number,
    col: number,
  ) => {
    const at = cellName({ row, col })
    const key = `${formula}\u0000${anchor.row},${anchor.col}\u0000${at}`
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    let out: CellValue
    try {
      const moved = translateFormula(formula, cellName(anchor), at)
      const r = calc.evaluate(sheet, moved, at)
      out = r.kept ? { error: '#N/A' } : r.value
    } catch {
      // A formula that can't be read or moved off the sheet (#REF!) is no condition.
      out = { error: '#REF!' }
    }
    memo.set(key, out)
    return out
  }
  return {
    value,
    test(formula, anchor, row, col) {
      const v = value(formula, anchor, row, col)
      if (typeof v === 'string') return false
      const t = truthy(v)
      return t === true
    },
  }
}

type Ref = { sheetName?: string; workbookName?: string; range?: Range; name?: string }

/**
 * The cells a list source names when it is a plain reference (a range,
 * `Sheet2!$A$1:$A$9`, or a name that refers to one): their values as they
 * are, blanks kept. null when the source is not a plain reference.
 */
export function referencedValues(
  wb: Workbook,
  calc: Calc,
  formula: string,
  home: string,
  depth = 0,
): CellValue[] | null {
  if (depth > 8) return null
  const toks = (
    tokenize(formula, { mergeRefs: true }) as Array<{ type: string; value: string }>
  ).filter((t) => t.type !== 'whitespace')
  if (toks.length !== 1) return null
  const t = toks[0]!
  const ref = parseA1Ref(t.value) as Ref | undefined
  if (!ref || ref.workbookName) return null
  if (t.type === 'range_named' && ref.name) {
    const homeInfo = wb.findSheet(home)
    const key = ref.name.toLowerCase()
    const names = wb.definedNames().filter((n) => n.name.toLowerCase() === key)
    const name =
      names.find((n) => n.localSheet !== null && n.localSheet === homeInfo?.index) ??
      names.find((n) => n.localSheet === null)
    return name ? referencedValues(wb, calc, name.formula, home, depth + 1) : null
  }
  if (t.type !== 'range' || !ref.range) return null
  const sheet = ref.sheetName ? wb.findSheet(ref.sheetName)?.name : home
  if (!sheet) return null
  const r = ref.range as Range & Record<string, number | null>
  const out: CellValue[] = []
  const bottom = Math.min(r.bottom ?? 1_048_575, r.top + 9_999)
  for (let row = r.top ?? 0; row <= bottom; row++)
    for (let col = r.left ?? 0; col <= (r.right ?? r.left ?? 0); col++)
      out.push(calc.cell(sheet, row, col).value)
  return out
}

/** A value as list text (numbers in Excel's General form). */
export function valueText(v: CellValue): string {
  if (v === null) return ''
  if (isErrorValue(v)) return v.error
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return String(Number(v.toPrecision(15)))
  return v
}
