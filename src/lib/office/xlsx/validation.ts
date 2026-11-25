import type { Calc } from './calc'
import { createCalc } from './calc'
import { parseInput } from './format'
import {
  applyOp,
  finishSheet,
  sheetDoc,
  toFileFormula,
  toShownFormula,
  type CellWrite,
} from './ops'
import { cellName, requireCell, type Range } from './ref'
import { referencedValues, ruleCalc, valueText, type RuleCalc } from './rule-formulas'
import {
  ERROR_STYLES,
  VALIDATION_OPERATORS,
  VALIDATION_TYPES,
  type ErrorStyle,
  type ValidationOperator,
  type ValidationType,
} from './rules-choices'
import { WORKSHEET_ORDER } from './sheet-order'
import { translateFormula } from './shift'
import { anchorOf, inRanges, parseSqref, requireSqref, sqrefText, subtractAll } from './sqref'
import { isErrorValue, XlsxError, type CellValue, type Workbook } from './workbook'
import { insertInOrder, kid, kids, make, setText, textOf } from './xml'

export { ERROR_STYLES, VALIDATION_OPERATORS, VALIDATION_TYPES }
export type { ErrorStyle, ValidationOperator, ValidationType }

/**
 * Data validation (ECMA-376 Part 1 §18.3.1.32 dataValidation; the Excel 2010
 * extension list for rules whose source is on another sheet): what a cell
 * may hold — a value from a list (typed inline, or the cells of a range or
 * name), a whole number, a decimal, a date, a time or a text length compared
 * with an operator, or a custom formula — with the input message shown on
 * the cell and the error alert when typing breaks it: Stop refuses the
 * entry, Warning asks whether to keep it, Information tells and keeps it.
 *
 * A typed entry is checked as Excel checks it: on the value the cell would
 * hold (a formula's result too), with the rule's formulas moved to the cell
 * — the write is tried in a transaction that is then undone. Clearing a cell
 * is never refused (Excel neither). "Circle invalid data" lists the filled
 * cells that break their rule now.
 */

/** A rule as people set it (the Data Validation dialog's fields). */
export type ValidationRule = {
  type: ValidationType
  operator?: ValidationOperator
  /** Formulas or values (with or without "="): the bound(s), the list source range, or the custom condition. */
  formula1?: string
  formula2?: string
  /** An inline list (type list): its items, written as Excel's "a,b,c". */
  items?: string[]
  /** Empty cells pass (default true). */
  allowBlank?: boolean
  /** The in-cell drop-down of a list (default true). */
  dropdown?: boolean
  inputTitle?: string | null
  inputMessage?: string | null
  errorStyle?: ErrorStyle
  errorTitle?: string | null
  errorMessage?: string | null
  /** Show the input message / the error alert (default true, as Excel's dialog). */
  showInput?: boolean
  showError?: boolean
}

export type ValidationView = Required<
  Pick<
    ValidationRule,
    'type' | 'operator' | 'allowBlank' | 'dropdown' | 'errorStyle' | 'showInput' | 'showError'
  >
> & {
  ranges: Range[]
  sqref: string
  /** As typed, with "=" (an inline list as its items instead). */
  formula1: string | null
  formula2: string | null
  items: string[] | null
  inputTitle: string | null
  inputMessage: string | null
  errorTitle: string | null
  errorMessage: string | null
  /** Written in the Excel 2010 extension list (read and cleared here; set rules are written in the main list). */
  extension: boolean
}

export type ValidationOp =
  | { op: 'validation_set'; sheet: string; range: string; rule: ValidationRule }
  | { op: 'validation_clear'; sheet: string; range: string }

export type Violation = {
  ref: string
  errorStyle: ErrorStyle
  title: string | null
  message: string | null
  /** The alert is switched off: the entry is kept without a word (Excel). */
  silent: boolean
}

const X14_DV_URI = '{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}'
const NS_X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
const NS_XM = 'http://schemas.microsoft.com/office/excel/2006/main'

const on = (v: string | null, fallback: boolean) =>
  v === null ? fallback : v === '1' || v === 'true'

/** An inline list as the file writes it ("a,b,c" in quotes) → its items; null when the source is not inline. */
function inlineItems(formula: string): string[] | null {
  const m = /^"(.*)"$/s.exec(formula.trim())
  if (!m) return null
  return m[1]!
    .replace(/""/g, '"')
    .split(',')
    .map((s) => s.trim())
}

function readRule(el: Element, extension: boolean): ValidationView {
  const f = (local: string) => {
    const x = kid(el, local, extension ? NS_X14 : undefined)
    if (!x) return null
    const inner = extension ? kid(x, 'f', NS_XM) : x
    const t = textOf(inner)
    return t === '' ? null : t
  }
  const sq = extension ? textOf(kid(el, 'sqref', NS_XM)) : (el.getAttribute('sqref') ?? '')
  const t = el.getAttribute('type') ?? 'none'
  const f1 = f('formula1')
  const items = t === 'list' && f1 ? inlineItems(f1) : null
  const ranges = parseSqref(sq)
  return {
    type: (t === 'none' ? 'any' : t) as ValidationType,
    operator: (el.getAttribute('operator') ?? 'between') as ValidationOperator,
    allowBlank: on(el.getAttribute('allowBlank'), false),
    // showDropDown="1" *hides* the in-cell drop-down (§18.3.1.32).
    dropdown: !on(el.getAttribute('showDropDown'), false),
    errorStyle: (el.getAttribute('errorStyle') ?? 'stop') as ErrorStyle,
    showInput: on(el.getAttribute('showInputMessage'), false),
    showError: on(el.getAttribute('showErrorMessage'), false),
    ranges,
    sqref: sqrefText(ranges),
    formula1: f1 === null || items ? null : `=${toShownFormula(f1)}`,
    formula2: f('formula2') === null ? null : `=${toShownFormula(f('formula2')!)}`,
    items,
    inputTitle: el.getAttribute('promptTitle'),
    inputMessage: el.getAttribute('prompt'),
    errorTitle: el.getAttribute('errorTitle'),
    errorMessage: el.getAttribute('error'),
    extension,
  }
}

function x14Validations(root: Element): Element | null {
  const ext = kid(root, 'extLst')
  const e = ext ? kids(ext, 'ext').find((x) => x.getAttribute('uri') === X14_DV_URI) : null
  return e ? kid(e, 'dataValidations', NS_X14) : null
}

export function validationsOf(wb: Workbook, sheet: string): ValidationView[] {
  const info = wb.requireWorksheet(sheet)
  const root = wb.pkg.xml(info.part).documentElement!
  const main = kid(root, 'dataValidations')
  const x14 = x14Validations(root)
  return [
    ...(main ? kids(main, 'dataValidation') : []).map((el) => readRule(el, false)),
    ...(x14 ? kids(x14, 'dataValidation', NS_X14) : []).map((el) => readRule(el, true)),
  ].filter((v) => v.ranges.length > 0)
}

export function validationAt(
  rules: ValidationView[],
  row: number,
  col: number,
): ValidationView | null {
  return rules.find((v) => inRanges(v.ranges, row, col)) ?? null
}

// ---------------------------------------------------------------------------
// Checking

const fileFormula = (text: string | null) => (text === null ? null : text.replace(/^=/, ''))

/** The items of a list rule for a cell: inline, or the values of its source range (blanks left out). */
export function listItems(
  wb: Workbook,
  calc: Calc,
  sheet: string,
  rule: ValidationView,
  row: number,
  col: number,
): string[] {
  if (rule.type !== 'list') return []
  if (rule.items) return rule.items
  const f = fileFormula(rule.formula1)
  if (!f) return []
  // A source with relative references moves with the cell, as the rule's other formulas do.
  const at = cellName({ row, col })
  let moved: string
  try {
    moved = translateFormula(f, cellName(anchorOf(rule.ranges)), at)
  } catch {
    return []
  }
  const direct = referencedValues(wb, calc, moved, sheet)
  if (direct) return direct.filter((v) => v !== null && v !== '').map(valueText)
  const r = calc.evaluate(sheet, moved, at)
  if (r.kept) return []
  const values = r.array ? r.array.flat() : [r.value]
  return values.filter((v) => v !== null && v !== '' && !isErrorValue(v)).map(valueText)
}

function compareOp(op: ValidationOperator, x: number, a: number, b: number): boolean {
  switch (op) {
    case 'between':
      return x >= Math.min(a, b) && x <= Math.max(a, b)
    case 'notBetween':
      return x < Math.min(a, b) || x > Math.max(a, b)
    case 'equal':
      return x === a
    case 'notEqual':
      return x !== a
    case 'greaterThan':
      return x > a
    case 'lessThan':
      return x < a
    case 'greaterThanOrEqual':
      return x >= a
    case 'lessThanOrEqual':
      return x <= a
  }
}

/** Whether value `v` in (row, col) passes `rule` (`rc` evaluates its formulas). */
export function passes(
  wb: Workbook,
  calc: Calc,
  rc: RuleCalc,
  sheet: string,
  rule: ValidationView,
  row: number,
  col: number,
  v: CellValue,
): boolean {
  if (rule.type === 'any') return true
  if (v === null || v === '') return rule.allowBlank
  const anchor = anchorOf(rule.ranges)
  const bound = (text: string | null) => {
    const f = fileFormula(text)
    if (!f) return NaN
    const b = rc.value(f, anchor, row, col)
    return typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' ? Number(b) : NaN
  }
  const numeric = (x: number) => {
    const a = bound(rule.formula1)
    const needsTwo = rule.operator === 'between' || rule.operator === 'notBetween'
    const b = needsTwo ? bound(rule.formula2) : a
    if (Number.isNaN(a) || Number.isNaN(b)) return false
    return compareOp(rule.operator, x, a, b)
  }
  switch (rule.type) {
    case 'whole':
      return typeof v === 'number' && Number.isInteger(v) && numeric(v)
    case 'decimal':
    case 'date':
    case 'time':
      return typeof v === 'number' && numeric(v)
    case 'textLength': {
      if (isErrorValue(v)) return false
      return numeric(valueText(v).length)
    }
    case 'list': {
      if (isErrorValue(v)) return false
      const items = listItems(wb, calc, sheet, rule, row, col)
      const text = valueText(v).toLowerCase()
      return items.some((i) => i.toLowerCase() === text)
    }
    case 'custom': {
      const f = fileFormula(rule.formula1)
      return !!f && rc.test(f, anchor, row, col)
    }
  }
}

/**
 * The validation alerts typing `writes` would raise (Stop, Warning,
 * Information), checked on the values the cells would then hold. The write
 * is tried and undone; the workbook is as before afterwards.
 */
export function checkWrites(wb: Workbook, sheet: string, writes: CellWrite[]): Violation[] {
  const info = wb.requireWorksheet(sheet)
  const rules = validationsOf(wb, info.name)
  const targets = writes.flatMap((w) => {
    if (w.value === null || w.value === '' || (w.value === undefined && w.formula === undefined))
      return []
    const a = requireCell(w.ref)
    const rule = validationAt(rules, a.row, a.col)
    return rule && rule.type !== 'any' ? [{ a, rule }] : []
  })
  if (targets.length === 0) return []
  const { images } = applyOp(
    wb,
    { op: 'set_cells', sheet: info.name, cells: writes },
    { acceptLosses: true },
  )
  try {
    const calc = createCalc(wb)
    const rc = ruleCalc(calc, info.name)
    return targets.flatMap(({ a, rule }) => {
      const v = calc.cell(info.name, a.row, a.col).value
      if (passes(wb, calc, rc, info.name, rule, a.row, a.col, v)) return []
      return [
        {
          ref: cellName(a),
          errorStyle: rule.errorStyle,
          title: rule.errorTitle,
          message: rule.errorMessage,
          silent: !rule.showError,
        },
      ]
    })
  } finally {
    wb.restore(images.before)
  }
}

/** The filled cells that break their validation now ("Circle invalid data"), at most `limit`. */
export function invalidCells(wb: Workbook, calc: Calc, sheet: string, limit = 1000): string[] {
  const info = wb.requireWorksheet(sheet)
  const rules = validationsOf(wb, info.name).filter((r) => r.type !== 'any')
  if (rules.length === 0) return []
  const rc = ruleCalc(calc, info.name)
  const out: string[] = []
  const data = wb.sheet(info.name)
  const cells = [...data.cells.values()].sort((a, b) => a.row - b.row || a.col - b.col)
  for (const cell of cells) {
    const rule = validationAt(rules, cell.row, cell.col)
    if (!rule) continue
    const v = calc.cell(info.name, cell.row, cell.col).value
    if (v === null || v === '') continue
    if (!passes(wb, calc, rc, info.name, rule, cell.row, cell.col, v)) {
      out.push(cellName(cell))
      if (out.length >= limit) break
    }
  }
  return out
}

/** Whether a cell has a drop-down (a list rule that shows it). */
export function hasDropdown(rules: ValidationView[], row: number, col: number): boolean {
  const r = validationAt(rules, row, col)
  return !!r && r.type === 'list' && r.dropdown
}

// ---------------------------------------------------------------------------
// Writing

const MAX_LIST = 255

function writeFormula(
  doc: XMLDocument,
  el: Element,
  local: 'formula1' | 'formula2',
  formula: string,
) {
  const f = make(doc, local)
  setText(doc, f, formula)
  el.appendChild(f)
}

function checkRule(rule: ValidationRule, where: string): { f1: string | null; f2: string | null } {
  if (!VALIDATION_TYPES.includes(rule.type))
    throw new XlsxError(`“${rule.type}” is not a kind of validation.`)
  const op = rule.operator ?? 'between'
  if (!VALIDATION_OPERATORS.includes(op)) throw new XlsxError(`“${op}” is not a comparison.`)
  if (rule.errorStyle && !['stop', 'warning', 'information'].includes(rule.errorStyle))
    throw new XlsxError(
      `“${rule.errorStyle}” is not an error alert style (stop, warning, information).`,
    )
  for (const [k, max] of [
    ['inputTitle', 32],
    ['errorTitle', 32],
    ['inputMessage', 255],
    ['errorMessage', 225],
  ] as const) {
    const v = rule[k]
    if (v && v.length > max)
      throw new XlsxError(
        `The ${k.replace(/([A-Z])/g, ' $1').toLowerCase()} can have at most ${max} characters.`,
      )
  }
  if (rule.type === 'any') return { f1: null, f2: null }
  if (rule.type === 'list') {
    if (rule.items) {
      if (rule.formula1) throw new XlsxError('Give the list’s items or its source range, not both.')
      if (rule.items.length === 0) throw new XlsxError('A list needs at least one item.')
      if (rule.items.some((i) => i.includes(',')))
        throw new XlsxError(
          'A list item typed into the rule can’t contain a comma; put the items in cells and use their range.',
        )
      const text = `"${rule.items
        .map((i) => i.trim())
        .join(',')
        .replace(/"/g, '""')}"`
      if (text.length - 2 > MAX_LIST)
        throw new XlsxError(
          `A typed list can have at most ${MAX_LIST} characters; put the items in cells and use their range.`,
        )
      return { f1: text, f2: null }
    }
    if (!rule.formula1)
      throw new XlsxError('A list needs its items or a source range (like =$E$1:$E$5).')
    return { f1: toFileFormula(rule.formula1, where), f2: null }
  }
  if (rule.type === 'custom') {
    if (!rule.formula1) throw new XlsxError('A custom rule needs its formula (like =A1>0).')
    return { f1: toFileFormula(rule.formula1, where), f2: null }
  }
  if (!rule.formula1) throw new XlsxError('Give the value to compare with.')
  const two = op === 'between' || op === 'notBetween'
  if (two && !rule.formula2) throw new XlsxError('“Between” needs a minimum and a maximum.')
  const bound = (raw: string) => {
    const t = raw.trim()
    if ((rule.type === 'date' || rule.type === 'time') && !t.startsWith('=')) {
      const p = parseInput(t, 'en')
      if (p.kind === 'value' && typeof p.value === 'number') return String(p.value)
    }
    return toFileFormula(raw, where)
  }
  return {
    f1: bound(rule.formula1),
    f2: two ? bound(rule.formula2!) : null,
  }
}

/** Takes `cuts` out of every rule's ranges (main list and extension list); rules left without cells go. */
function cutRules(doc: XMLDocument, cuts: Range[]) {
  const root = doc.documentElement!
  const main = kid(root, 'dataValidations')
  for (const el of main ? kids(main, 'dataValidation') : []) {
    const rest = subtractAll(parseSqref(el.getAttribute('sqref') ?? ''), cuts)
    if (rest.length === 0) main!.removeChild(el)
    else el.setAttribute('sqref', sqrefText(rest))
  }
  if (main) {
    const n = kids(main, 'dataValidation').length
    if (n === 0) root.removeChild(main)
    else main.setAttribute('count', String(n))
  }
  const x14 = x14Validations(root)
  for (const el of x14 ? kids(x14, 'dataValidation', NS_X14) : []) {
    const sq = kid(el, 'sqref', NS_XM)
    const rest = subtractAll(parseSqref(textOf(sq)), cuts)
    if (rest.length === 0) x14!.removeChild(el)
    else if (sq) setText(doc, sq, sqrefText(rest))
  }
  if (x14) {
    const n = kids(x14, 'dataValidation', NS_X14).length
    if (n === 0) {
      const ext = x14.parentNode as Element
      const lst = ext.parentNode as Element
      lst.removeChild(ext)
      if (kids(lst, 'ext').length === 0) root.removeChild(lst)
    } else x14.setAttribute('count', String(n))
  }
}

export function runValidationOp(wb: Workbook, op: ValidationOp): string[] {
  const info = wb.requireWorksheet(op.sheet)
  const ranges = requireSqref(op.range)
  if (op.op === 'validation_clear') {
    const before = validationsOf(wb, info.name).length
    const doc = sheetDoc(wb, info)
    cutRules(doc, ranges)
    finishSheet(wb, info, doc)
    return before > 0 ? [info.name] : []
  }
  const rule = op.rule
  const { f1, f2 } = checkRule(rule, `${info.name}!${sqrefText(ranges)}`)
  const doc = sheetDoc(wb, info)
  cutRules(doc, ranges)
  if (rule.type === 'any' && !rule.inputMessage && !rule.inputTitle) {
    finishSheet(wb, info, doc)
    return [info.name]
  }
  const root = doc.documentElement!
  let list = kid(root, 'dataValidations')
  if (!list) {
    list = make(doc, 'dataValidations')
    insertInOrder(root, list, WORKSHEET_ORDER)
  }
  const el = make(doc, 'dataValidation')
  if (rule.type !== 'any') el.setAttribute('type', rule.type)
  if (rule.errorStyle && rule.errorStyle !== 'stop') el.setAttribute('errorStyle', rule.errorStyle)
  const op2 = rule.operator ?? 'between'
  if (op2 !== 'between' && rule.type !== 'list' && rule.type !== 'custom' && rule.type !== 'any')
    el.setAttribute('operator', op2)
  if (rule.allowBlank ?? true) el.setAttribute('allowBlank', '1')
  if (rule.type === 'list' && rule.dropdown === false) el.setAttribute('showDropDown', '1')
  if (rule.showInput ?? true) el.setAttribute('showInputMessage', '1')
  if (rule.showError ?? true) el.setAttribute('showErrorMessage', '1')
  if (rule.errorTitle) el.setAttribute('errorTitle', rule.errorTitle)
  if (rule.errorMessage) el.setAttribute('error', rule.errorMessage)
  if (rule.inputTitle) el.setAttribute('promptTitle', rule.inputTitle)
  if (rule.inputMessage) el.setAttribute('prompt', rule.inputMessage)
  el.setAttribute('sqref', sqrefText(ranges))
  if (f1 !== null) writeFormula(doc, el, 'formula1', f1)
  if (f2 !== null) writeFormula(doc, el, 'formula2', f2)
  list.appendChild(el)
  list.setAttribute('count', String(kids(list, 'dataValidation').length))
  finishSheet(wb, info, doc)
  return [info.name]
}

/** For the grid: the cell's rule and its drop-down items, read once per change. */
export function validationReader(wb: Workbook, calc: Calc, sheet: string) {
  const rules = validationsOf(wb, sheet)
  const rc = ruleCalc(calc, sheet)
  return {
    rules,
    at: (row: number, col: number) => validationAt(rules, row, col),
    dropdown: (row: number, col: number) => hasDropdown(rules, row, col),
    items: (row: number, col: number) => {
      const r = validationAt(rules, row, col)
      return r ? listItems(wb, calc, sheet, r, row, col) : []
    },
    /** The cell's current value fails its rule. */
    invalid: (row: number, col: number) => {
      const r = validationAt(rules, row, col)
      if (!r || r.type === 'any') return false
      const v = calc.cell(sheet, row, col).value
      if (v === null || v === '') return false
      return !passes(wb, calc, rc, sheet, r, row, col, v)
    },
  }
}
