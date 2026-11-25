import { translateFormulaToA1, translateFormulaToR1C1 } from '@borgar/fx'
import { parseA1Ref, stringifyA1Ref, tokenize } from '@borgar/fx/xlsx'
import { MAX_COLS, MAX_ROWS } from './ref'

/**
 * Formula references moved and renamed with the cells they point at
 * (insert/delete rows and columns, rename a sheet), and shared formulas
 * (ECMA-376 Part 1 §18.3.1.40) written out for each cell they cover. The
 * formula is tokenized (@borgar/fx, MIT); only reference tokens change,
 * everything else is written back exactly.
 */

/** A shared formula as written for its anchor cell, as it reads at `to` (relative references move along). */
export function translateFormula(text: string, from: string, to: string): string {
  if (from === to) return text
  return translateFormulaToA1(translateFormulaToR1C1(text, from), to)
}

/** A rectangle with null sides for whole rows/columns (A:A has no top or bottom). */
export type RefRange = { top: number | null; left: number | null; bottom: number | null; right: number | null }

/** What becomes of one reference: a new rectangle, "#REF!" (it was deleted), or null (unchanged). */
export type RefEdit = (sheet: string, range: RefRange) => RefRange | '#REF!' | null

type ParsedRef = { workbookName?: string; sheetName?: string; range?: RefRange & Record<string, unknown>; name?: string }

const tokens = (formula: string) => tokenize(formula, { mergeRefs: true }) as Array<{ type: string; value: string }>

/**
 * Rewrites the cell references of `formula` (written on sheet `home`) with
 * `edit`; references into other workbooks and defined names stay as they are.
 * A deleted reference reads `Sheet!#REF!` (as Excel writes it), or a bare
 * `#REF!` with `bare` (its sheet is gone).
 */
export function rewriteRefs(formula: string, home: string, edit: RefEdit, opts: { bare?: boolean } = {}): string {
  let changed = false
  const out = tokens(formula).map((t) => {
    if (t.type !== 'range' && t.type !== 'range_beam') return t.value
    const ref = parseA1Ref(t.value) as ParsedRef | undefined
    if (!ref?.range || ref.workbookName) return t.value
    const next = edit(ref.sheetName || home, ref.range)
    if (next === null) return t.value
    changed = true
    if (next === '#REF!') return ref.sheetName && !opts.bare ? `${quoteSheet(ref.sheetName)}!#REF!` : '#REF!'
    return stringifyA1Ref({ ...ref, range: { ...ref.range, ...next } } as never)
  })
  return changed ? out.join('') : formula
}

/**
 * The tokens of a formula ready for the parser: `Sheet1!#REF!` (a reference
 * Excel deleted, §18.17.2.4) reads as the error itself.
 */
export function parseableTokens(formula: string): Array<{ type: string; value: string }> {
  const toks = tokens(formula)
  const out: Array<{ type: string; value: string }> = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.type === 'context' && toks[i + 1]?.value === '!' && toks[i + 2]?.type === 'error') {
      i++
      continue
    }
    out.push(t)
  }
  return out
}

/** Renames sheet `from` to `to` in every reference of `formula`. */
export function renameSheetRefs(formula: string, from: string, to: string): string {
  const key = from.toLowerCase()
  let changed = false
  const out = tokens(formula).map((t) => {
    if (t.type !== 'range' && t.type !== 'range_beam') return t.value
    const ref = parseA1Ref(t.value) as ParsedRef | undefined
    if (!ref?.range || ref.workbookName || ref.sheetName?.toLowerCase() !== key) return t.value
    changed = true
    return stringifyA1Ref({ ...ref, sheetName: to } as never)
  })
  return changed ? out.join('') : formula
}

/** Whether `formula` has a reference into sheet `name` (written on sheet `home`). */
export function refersTo(formula: string, home: string, name: string): boolean {
  const key = name.toLowerCase()
  return tokens(formula).some((t) => {
    if (t.type !== 'range' && t.type !== 'range_beam') return false
    const ref = parseA1Ref(t.value) as ParsedRef | undefined
    return !!ref?.range && !ref.workbookName && (ref.sheetName || home).toLowerCase() === key
  })
}

export function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`
}

/** Inserting `count` rows (axis 'row') or columns at index `at` of sheet `sheet`. */
export function insertEdit(sheetName: string, axis: 'row' | 'col', at: number, count: number): RefEdit {
  const key = sheetName.toLowerCase()
  const [lo, hi] = axis === 'row' ? (['top', 'bottom'] as const) : (['left', 'right'] as const)
  const limit = axis === 'row' ? MAX_ROWS : MAX_COLS
  return (sheet, range) => {
    if (sheet.toLowerCase() !== key) return null
    const a = range[lo]
    const b = range[hi]
    if (a === null || b === null) return null
    if (b < at) return null
    const na = a >= at ? a + count : a
    const nb = b + count
    if (nb >= limit) return '#REF!'
    return { ...range, [lo]: na, [hi]: nb }
  }
}

/** Deleting `count` rows/columns from index `at` of sheet `sheet`. */
export function deleteEdit(sheetName: string, axis: 'row' | 'col', at: number, count: number): RefEdit {
  const key = sheetName.toLowerCase()
  const [lo, hi] = axis === 'row' ? (['top', 'bottom'] as const) : (['left', 'right'] as const)
  const end = at + count - 1
  return (sheet, range) => {
    if (sheet.toLowerCase() !== key) return null
    const a = range[lo]
    const b = range[hi]
    if (a === null || b === null) return null
    if (b < at) return null
    if (a > end) return { ...range, [lo]: a - count, [hi]: b - count }
    if (a >= at && b <= end) return '#REF!'
    return { ...range, [lo]: a < at ? a : at, [hi]: b > end ? b - count : at - 1 }
  }
}

/** The same edit applied to a plain rectangle (merged cells, hyperlinks, sqref lists): null when it was deleted. */
export function editRange<T extends { top: number; left: number; bottom: number; right: number }>(r: T, sheet: string, edit: RefEdit): T | null {
  const next = edit(sheet, r)
  if (next === null) return r
  if (next === '#REF!') return null
  return { ...r, ...(next as T) }
}
