import type { Calc } from './calc'
import { compare } from './calc-values'
import { finishSheet, sheetDoc, stylesDoc, toFileFormula, toShownFormula } from './ops'
import { cellName, type Range } from './ref'
import { ruleCalc } from './rule-formulas'
import {
  CF_OPERATORS,
  CF_TYPES,
  CFVO_KINDS,
  ICON_SETS,
  TIME_PERIODS,
  type CfOperator,
  type CfType,
  type CfvoKind,
  type IconSetName,
  type TimePeriod,
} from './rules-choices'
import { WORKSHEET_ORDER } from './sheet-order'
import { translateFormula } from './shift'
import { anchorOf, inRanges, parseSqref, requireSqref, sqrefText, subtractAll } from './sqref'
import { argb, deepSignature } from './style-records'
import { colorReader, STYLESHEET_ORDER } from './styles'
import { isErrorValue, XlsxError, type CellValue, type Workbook } from './workbook'
import { all, insertInOrder, kid, kids, make, REL_STYLES, REL_THEME, setText, textOf } from './xml'

export { CF_OPERATORS, CF_TYPES, CFVO_KINDS, ICON_SETS, TIME_PERIODS }
export type { CfOperator, CfType, CfvoKind, IconSetName, TimePeriod }

/**
 * Conditional formatting (ECMA-376 Part 1 §18.3.1.10 cfRule, §18.3.1.18
 * conditionalFormatting; the Excel 2010 extension list for data bars with
 * negative values, the newer icon sets and custom icons): every rule type
 * evaluated and drawn as Excel documents it — cell value comparisons,
 * formulas (by our calculator, moved from the rule's first cell), 2- and
 * 3-colour scales, data bars, icon sets, top/bottom N or N %, above/below
 * average (with standard deviations), duplicate/unique values, text that
 * contains / doesn't / begins / ends with, blanks, errors and dates in a
 * period. Rules apply in priority order: a higher rule's format wins where
 * two set the same thing, both apply where they don't, and "Stop If True"
 * ends the list for a cell it matches.
 *
 * Rules are added (on top, priority 1, as Excel does), edited, deleted,
 * cleared from a range (the rest of their ranges stays) and reordered, and
 * written as Excel writes them: a `dxf` record in the styles part for the
 * format, the standard formula for text/blank/error/date rules, and for a
 * data bar the Excel 2010 extension (`x14:dataBar`, linked by `x14:id`) so
 * negative values and solid fills show as in Excel; icon sets Excel 2007
 * doesn't know (3Stars, 3Triangles, 5Boxes, custom icons) only in the
 * extension list, where Excel writes them.
 */

export const NS_X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
export const NS_XM = 'http://schemas.microsoft.com/office/excel/2006/main'
const X14_CF_URI = '{78C0D931-6437-407d-A8EE-F0AAD7539E65}'
const X14_ID_URI = '{B025F937-C7B1-47D3-B67F-A62EFF666E3E}'

const X14_ONLY_SETS = new Set<string>(['3Stars', '3Triangles', '5Boxes'])

export type Cfvo = { kind: CfvoKind; value: string | null; gte: boolean }

/** A differential format (§18.8.17 dxf): only what it sets. */
export type CfStyle = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** "#RRGGBB" */
  fontColor?: string
  fill?: string
  /** A line on every edge, this colour. */
  border?: string
  numFmt?: string
}

export type CfRuleView = {
  /** The rule's priority: its place in the list (1 = first), and how tools name it. */
  priority: number
  type: CfType
  ranges: Range[]
  sqref: string
  stopIfTrue: boolean
  style: CfStyle | null
  operator: CfOperator | null
  /** As typed (with "="), relative to the first cell of the ranges. */
  formulas: string[]
  text: string | null
  period: TimePeriod | null
  rank: number | null
  percent: boolean
  bottom: boolean
  below: boolean
  equalAverage: boolean
  stdDev: number | null
  colorScale: { points: Cfvo[]; colors: string[] } | null
  dataBar: {
    min: Cfvo
    max: Cfvo
    color: string
    gradient: boolean
    showValue: boolean
    minLength: number
    maxLength: number
    border: string | null
    negativeColor: string | null
    axis: 'automatic' | 'middle' | 'none'
    axisColor: string | null
  } | null
  iconSet: {
    set: IconSetName
    thresholds: Cfvo[]
    reverse: boolean
    showValue: boolean
    /** Custom icons per position (x14): another set's icon, or none. */
    custom: Array<{ set: IconSetName | 'NoIcons'; index: number } | null> | null
  } | null
  /** Written in the Excel 2010 extension list. */
  extension: boolean
}

/** What conditional formatting draws on one cell. */
export type CfLook = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  fontColor?: string
  fill?: string
  border?: string
  numFmt?: string
  /** A data bar from `from` to `to` (percent of the cell's width). */
  bar?: {
    from: number
    to: number
    color: string
    gradient: boolean
    border: string | null
    negative: boolean
    axis: number | null
    axisColor: string | null
  }
  icon?: { set: IconSetName; index: number }
  /** The data bar's / icon set's "Show bar only" / "Show icon only". */
  hideValue?: boolean
}

// ---------------------------------------------------------------------------
// Reading

const bool = (v: string | null, fallback: boolean) =>
  v === null ? fallback : v === '1' || v === 'true'

function themeDoc(wb: Workbook): XMLDocument | null {
  const rel = wb.pkg.relationships(wb.part).find((r) => r.type === REL_THEME && r.part)
  return rel?.part && wb.pkg.has(rel.part) ? wb.pkg.xml(rel.part) : null
}

function stylesXml(wb: Workbook): XMLDocument | null {
  const rel = wb.pkg.relationships(wb.part).find((r) => r.type === REL_STYLES && r.part)
  return rel?.part && wb.pkg.has(rel.part) ? wb.pkg.xml(rel.part) : null
}

function readDxf(el: Element | null, color: (el: Element | null) => string | null): CfStyle | null {
  if (!el) return null
  const out: CfStyle = {}
  const font = kid(el, 'font')
  if (font) {
    const flag = (n: string) => {
      const f = kid(font, n)
      if (!f) return undefined
      return bool(f.getAttribute('val'), true)
    }
    const b = flag('b')
    const i = flag('i')
    const s = flag('strike')
    if (b !== undefined) out.bold = b
    if (i !== undefined) out.italic = i
    if (s !== undefined) out.strike = s
    const u = kid(font, 'u')
    if (u) out.underline = u.getAttribute('val') !== 'none'
    const c = color(kid(font, 'color'))
    if (c) out.fontColor = c
  }
  const fill = kid(el, 'fill')
  const pf = fill ? kid(fill, 'patternFill') : null
  if (pf && pf.getAttribute('patternType') !== 'none') {
    // A dxf's solid fill is its background colour (§18.8.32); a pattern's foreground when that is all it has.
    const c = color(kid(pf, 'bgColor')) ?? color(kid(pf, 'fgColor'))
    if (c) out.fill = c
  }
  const border = kid(el, 'border')
  if (border) {
    const edge = ['left', 'right', 'top', 'bottom']
      .map((n) => kid(border, n))
      .find((e) => e && e.getAttribute('style') && e.getAttribute('style') !== 'none')
    if (edge) out.border = color(kid(edge, 'color')) ?? '#000000'
  }
  const nf = kid(el, 'numFmt')
  if (nf?.getAttribute('formatCode')) out.numFmt = nf.getAttribute('formatCode')!
  return out
}

function readCfvo(el: Element, x14: boolean): Cfvo {
  const kind = (el.getAttribute('type') ?? 'num') as CfvoKind
  const v = x14 ? textOf(kid(el, 'f', NS_XM)) || el.getAttribute('val') : el.getAttribute('val')
  return { kind, value: v === null || v === '' ? null : v, gte: bool(el.getAttribute('gte'), true) }
}

function blankRule(
  priority: number,
  type: CfType,
  ranges: Range[],
  extension: boolean,
): CfRuleView {
  return {
    priority,
    type,
    ranges,
    sqref: sqrefText(ranges),
    stopIfTrue: false,
    style: null,
    operator: null,
    formulas: [],
    text: null,
    period: null,
    rank: null,
    percent: false,
    bottom: false,
    below: false,
    equalAverage: false,
    stdDev: null,
    colorScale: null,
    dataBar: null,
    iconSet: null,
    extension,
  }
}

function readRule(
  el: Element,
  ranges: Range[],
  x14: boolean,
  dxfs: Element[],
  color: (el: Element | null) => string | null,
  x14Bars: Map<string, Element>,
): CfRuleView | null {
  const type = el.getAttribute('type') as CfType | null
  if (!type || !CF_TYPES.includes(type)) return null
  const ns = x14 ? NS_X14 : undefined
  const r = blankRule(Number(el.getAttribute('priority') ?? 0), type, ranges, x14)
  r.stopIfTrue = bool(el.getAttribute('stopIfTrue'), false)
  const dxfId = el.getAttribute('dxfId')
  r.style = x14
    ? readDxf(kid(el, 'dxf', NS_X14), color)
    : dxfId !== null
      ? readDxf(dxfs[Number(dxfId)] ?? null, color)
      : null
  const op = el.getAttribute('operator')
  r.operator = op && (CF_OPERATORS as readonly string[]).includes(op) ? (op as CfOperator) : null
  r.formulas = (x14 ? kids(el, 'f', NS_XM) : kids(el, 'formula')).map(
    (f) => `=${toShownFormula(textOf(f))}`,
  )
  r.text = el.getAttribute('text')
  const tp = el.getAttribute('timePeriod')
  r.period = tp && (TIME_PERIODS as readonly string[]).includes(tp) ? (tp as TimePeriod) : null
  const rank = el.getAttribute('rank')
  r.rank = rank !== null ? Number(rank) : null
  r.percent = bool(el.getAttribute('percent'), false)
  r.bottom = bool(el.getAttribute('bottom'), false)
  r.below = !bool(el.getAttribute('aboveAverage'), true)
  r.equalAverage = bool(el.getAttribute('equalAverage'), false)
  const sd = el.getAttribute('stdDev')
  r.stdDev = sd !== null ? Number(sd) : null
  const cs = kid(el, 'colorScale', ns)
  if (cs)
    r.colorScale = {
      points: kids(cs, 'cfvo', ns).map((c) => readCfvo(c, x14)),
      colors: (x14 ? kids(cs, 'color', NS_X14) : kids(cs, 'color')).map(
        (c) => color(c) ?? '#000000',
      ),
    }
  const db = kid(el, 'dataBar', ns)
  if (db) {
    const vos = kids(db, 'cfvo', ns).map((c) => readCfvo(c, x14))
    let bar: NonNullable<CfRuleView['dataBar']> = {
      min: vos[0] ?? { kind: 'min', value: null, gte: true },
      max: vos[1] ?? { kind: 'max', value: null, gte: true },
      color: color(kid(db, x14 ? 'fillColor' : 'color', ns)) ?? '#638EC6',
      gradient: true,
      showValue: bool(db.getAttribute('showValue'), true),
      minLength: Number(db.getAttribute('minLength') ?? 10),
      maxLength: Number(db.getAttribute('maxLength') ?? 90),
      border: null,
      negativeColor: null,
      axis: 'none',
      axisColor: null,
    }
    const extId = x14 ? null : textOf(findX14Id(el))
    const ext = extId ? x14Bars.get(extId) : x14 ? db : null
    if (ext) bar = withX14Bar(bar, ext, color)
    r.dataBar = bar
  }
  const is = kid(el, 'iconSet', ns)
  if (is) {
    const set = (is.getAttribute('iconSet') ?? '3TrafficLights1') as IconSetName
    const custom =
      x14 && bool(is.getAttribute('custom'), false)
        ? kids(is, 'cfIcon', NS_X14).map((c) => {
            const s = c.getAttribute('iconSet') as IconSetName | 'NoIcons'
            return { set: s, index: Number(c.getAttribute('iconId') ?? 0) }
          })
        : null
    r.iconSet = {
      set: set in ICON_SETS ? set : '3TrafficLights1',
      thresholds: kids(is, 'cfvo', ns).map((c) => readCfvo(c, x14)),
      reverse: bool(is.getAttribute('reverse'), false),
      showValue: bool(is.getAttribute('showValue'), true),
      custom,
    }
  }
  return r
}

function findX14Id(rule: Element): Element | null {
  const lst = kid(rule, 'extLst')
  const ext = lst ? kids(lst, 'ext').find((e) => e.getAttribute('uri') === X14_ID_URI) : null
  return ext ? kid(ext, 'id', NS_X14) : null
}

function withX14Bar(
  bar: NonNullable<CfRuleView['dataBar']>,
  el: Element,
  color: (el: Element | null) => string | null,
): NonNullable<CfRuleView['dataBar']> {
  const db = el.localName === 'dataBar' ? el : kid(el, 'dataBar', NS_X14)
  if (!db) return bar
  const vos = kids(db, 'cfvo', NS_X14).map((c) => readCfvo(c, true))
  const axis = db.getAttribute('axisPosition')
  return {
    ...bar,
    min: vos[0] ?? bar.min,
    max: vos[1] ?? bar.max,
    color: color(kid(db, 'fillColor', NS_X14)) ?? bar.color,
    gradient: bool(db.getAttribute('gradient'), true),
    minLength: Number(db.getAttribute('minLength') ?? 10),
    maxLength: Number(db.getAttribute('maxLength') ?? 90),
    border: bool(db.getAttribute('border'), false)
      ? (color(kid(db, 'borderColor', NS_X14)) ?? bar.color)
      : null,
    negativeColor: bool(db.getAttribute('negativeBarColorSameAsPositive'), false)
      ? bar.color
      : (color(kid(db, 'negativeFillColor', NS_X14)) ?? '#FF0000'),
    axis: axis === 'middle' || axis === 'none' ? axis : 'automatic',
    axisColor: color(kid(db, 'axisColor', NS_X14)),
  }
}

function x14Formattings(root: Element): Element | null {
  const lst = kid(root, 'extLst')
  const ext = lst ? kids(lst, 'ext').find((e) => e.getAttribute('uri') === X14_CF_URI) : null
  return ext ? kid(ext, 'conditionalFormattings', NS_X14) : null
}

/** The sheet's rules in priority order (main list and Excel 2010 extension list together). */
export function cfRulesOf(wb: Workbook, sheet: string): CfRuleView[] {
  const info = wb.requireWorksheet(sheet)
  const root = wb.pkg.xml(info.part).documentElement!
  const sdoc = stylesXml(wb)
  const color = colorReader(sdoc, themeDoc(wb))
  const dxfsEl = sdoc ? kid(sdoc.documentElement!, 'dxfs') : null
  const dxfs = dxfsEl ? kids(dxfsEl, 'dxf') : []
  const x14 = x14Formattings(root)
  const x14Bars = new Map<string, Element>()
  const x14Rules: Array<{ el: Element; ranges: Range[] }> = []
  for (const cf of x14 ? kids(x14, 'conditionalFormatting', NS_X14) : []) {
    const ranges = parseSqref(textOf(kid(cf, 'sqref', NS_XM)))
    for (const rule of kids(cf, 'cfRule', NS_X14)) {
      const id = rule.getAttribute('id')
      if (rule.getAttribute('type') === 'dataBar' && id && !rule.getAttribute('priority'))
        x14Bars.set(id, rule)
      else x14Rules.push({ el: rule, ranges })
    }
  }
  const out: CfRuleView[] = []
  for (const cf of kids(root, 'conditionalFormatting')) {
    const ranges = parseSqref(cf.getAttribute('sqref') ?? '')
    for (const rule of kids(cf, 'cfRule')) {
      const r = readRule(rule, ranges, false, dxfs, color, x14Bars)
      if (r && ranges.length) out.push(r)
    }
  }
  for (const { el, ranges } of x14Rules) {
    const r = readRule(el, ranges, true, dxfs, color, x14Bars)
    if (r && ranges.length) out.push(r)
  }
  return out.sort((a, b) => a.priority - b.priority)
}

// ---------------------------------------------------------------------------
// Evaluating

type Stats = { nums: number[]; min: number; max: number }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const k = (sorted.length - 1) * Math.min(1, Math.max(0, p))
  const lo = Math.floor(k)
  const hi = Math.ceil(k)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (k - lo)
}

function mix(a: string, b: string, t: number): string {
  const ca = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
  const cb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
  return `#${ca
    .map((x, i) =>
      Math.round(x + (cb[i]! - x) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`
}

/** Excel's own formula for text, blank, error and date rules, written for the cell `at` (relative). */
export function standardFormula(
  type: CfType,
  at: string,
  text: string | null,
  period: TimePeriod | null,
): string | null {
  const q = `"${(text ?? '').replace(/"/g, '""')}"`
  switch (type) {
    case 'containsText':
      return `NOT(ISERROR(SEARCH(${q},${at})))`
    case 'notContainsText':
      return `ISERROR(SEARCH(${q},${at}))`
    case 'beginsWith':
      return `LEFT(${at},LEN(${q}))=${q}`
    case 'endsWith':
      return `RIGHT(${at},LEN(${q}))=${q}`
    case 'containsBlanks':
      return `LEN(TRIM(${at}))=0`
    case 'notContainsBlanks':
      return `LEN(TRIM(${at}))>0`
    case 'containsErrors':
      return `ISERROR(${at})`
    case 'notContainsErrors':
      return `NOT(ISERROR(${at}))`
    case 'timePeriod': {
      const d = `FLOOR(${at},1)`
      const r = `ROUNDDOWN(${at},0)`
      switch (period) {
        case 'today':
          return `${d}=TODAY()`
        case 'yesterday':
          return `${d}=TODAY()-1`
        case 'tomorrow':
          return `${d}=TODAY()+1`
        case 'last7Days':
          return `AND(TODAY()-${d}<=6,${d}<=TODAY())`
        case 'thisWeek':
          return `AND(TODAY()-${r}<=WEEKDAY(TODAY())-1,${r}-TODAY()<=7-WEEKDAY(TODAY()))`
        case 'lastWeek':
          return `AND(TODAY()-${r}>=(WEEKDAY(TODAY())),TODAY()-${r}<(WEEKDAY(TODAY())+7))`
        case 'nextWeek':
          return `AND(${r}-TODAY()>(7-WEEKDAY(TODAY())),${r}-TODAY()<(15-WEEKDAY(TODAY())))`
        case 'thisMonth':
          return `AND(MONTH(${at})=MONTH(TODAY()),YEAR(${at})=YEAR(TODAY()))`
        case 'lastMonth':
          return `AND(MONTH(${at})=MONTH(EDATE(TODAY(),0-1)),YEAR(${at})=YEAR(EDATE(TODAY(),0-1)))`
        case 'nextMonth':
          return `AND(MONTH(${at})=MONTH(EDATE(TODAY(),0+1)),YEAR(${at})=YEAR(EDATE(TODAY(),0+1)))`
        default:
          return null
      }
    }
    default:
      return null
  }
}

const dupKey = (v: CellValue): string | null => {
  if (v === null || v === '') return null
  if (typeof v === 'number') return `n${v}`
  if (typeof v === 'boolean') return `b${v}`
  if (isErrorValue(v)) return `e${v.error}`
  return `s${v.toLowerCase()}`
}

/**
 * The conditional formatting of one sheet, evaluated: what each cell shows.
 * Statistics a rule needs over its cells (min/max, ranks, averages,
 * duplicates) are worked out once per rule.
 */
export function cfEvaluator(
  wb: Workbook,
  calc: Calc,
  sheet: string,
): (row: number, col: number) => CfLook | null {
  const info = wb.requireWorksheet(sheet)
  const rules = cfRulesOf(wb, info.name)
  if (rules.length === 0) return () => null
  const rc = ruleCalc(calc, info.name)
  const data = wb.sheet(info.name)
  const value = (r: number, c: number) => calc.cell(info.name, r, c).value
  const statsMemo = new Map<CfRuleView, Stats>()
  const dupMemo = new Map<CfRuleView, Map<string, number>>()
  const cellsIn = (rule: CfRuleView) =>
    [...data.cells.values()].filter((c) => inRanges(rule.ranges, c.row, c.col))
  const stats = (rule: CfRuleView): Stats => {
    let s = statsMemo.get(rule)
    if (!s) {
      const nums = cellsIn(rule)
        .map((c) => value(c.row, c.col))
        .filter((v): v is number => typeof v === 'number')
        .sort((a, b) => a - b)
      s = { nums, min: nums[0] ?? NaN, max: nums.at(-1) ?? NaN }
      statsMemo.set(rule, s)
    }
    return s
  }
  const dups = (rule: CfRuleView) => {
    let m = dupMemo.get(rule)
    if (!m) {
      m = new Map()
      for (const c of cellsIn(rule)) {
        const k = dupKey(value(c.row, c.col))
        if (k) m.set(k, (m.get(k) ?? 0) + 1)
      }
      dupMemo.set(rule, m)
    }
    return m
  }
  const vo = (rule: CfRuleView, v: Cfvo, s: Stats): number => {
    const anchor = anchorOf(rule.ranges)
    const num = () => {
      if (v.value === null) return NaN
      const n = Number(v.value)
      if (Number.isFinite(n)) return n
      const out = rc.value(v.value.replace(/^=/, ''), anchor, anchor.row, anchor.col)
      return typeof out === 'number' ? out : NaN
    }
    switch (v.kind) {
      case 'min':
        return s.min
      case 'max':
        return s.max
      case 'autoMin':
        return Math.min(0, s.min)
      case 'autoMax':
        return Math.max(0, s.max)
      case 'num':
      case 'formula':
        return num()
      case 'percent':
        return s.min + ((s.max - s.min) * num()) / 100
      case 'percentile':
        return percentile(s.nums, num() / 100)
    }
  }

  const matches = (rule: CfRuleView, r: number, c: number): boolean => {
    const v = value(r, c)
    const anchor = anchorOf(rule.ranges)
    const f = (i: number) => (rule.formulas[i] ?? '').replace(/^=/, '')
    switch (rule.type) {
      case 'cellIs': {
        if (isErrorValue(v) || !rule.operator) return false
        const a = rc.value(f(0), anchor, r, c)
        if (isErrorValue(a)) return false
        const cmp = (x: CellValue) => compare(v, x)
        switch (rule.operator) {
          case 'between':
          case 'notBetween': {
            const b = rc.value(f(1), anchor, r, c)
            if (isErrorValue(b)) return false
            const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a]
            const inside = cmp(lo) >= 0 && cmp(hi) <= 0
            return rule.operator === 'between' ? inside : !inside
          }
          case 'equal':
            return cmp(a) === 0
          case 'notEqual':
            return cmp(a) !== 0
          case 'greaterThan':
            return cmp(a) > 0
          case 'lessThan':
            return cmp(a) < 0
          case 'greaterThanOrEqual':
            return cmp(a) >= 0
          case 'lessThanOrEqual':
            return cmp(a) <= 0
        }
        return false
      }
      case 'expression':
        return rule.formulas.length > 0 && rc.test(f(0), anchor, r, c)
      case 'containsText':
      case 'notContainsText':
      case 'beginsWith':
      case 'endsWith':
      case 'containsBlanks':
      case 'notContainsBlanks':
      case 'containsErrors':
      case 'notContainsErrors':
      case 'timePeriod': {
        const formula =
          rule.formulas.length > 0
            ? f(0)
            : standardFormula(rule.type, cellName(anchor), rule.text, rule.period)
        return !!formula && rc.test(formula, anchor, r, c)
      }
      case 'top10': {
        if (typeof v !== 'number' || rule.rank === null) return false
        const s = stats(rule)
        const n = rule.percent
          ? Math.max(1, Math.floor((s.nums.length * rule.rank) / 100))
          : rule.rank
        if (n < 1 || s.nums.length === 0) return false
        const k = Math.min(n, s.nums.length)
        return rule.bottom ? v <= s.nums[k - 1]! : v >= s.nums[s.nums.length - k]!
      }
      case 'aboveAverage': {
        if (typeof v !== 'number') return false
        const s = stats(rule)
        if (s.nums.length === 0) return false
        const avg = s.nums.reduce((a, b) => a + b, 0) / s.nums.length
        if (rule.stdDev !== null && rule.stdDev > 0) {
          if (s.nums.length < 2) return false
          const sd = Math.sqrt(s.nums.reduce((a, b) => a + (b - avg) ** 2, 0) / (s.nums.length - 1))
          const edge = rule.below ? avg - rule.stdDev * sd : avg + rule.stdDev * sd
          return rule.below
            ? rule.equalAverage
              ? v <= edge
              : v < edge
            : rule.equalAverage
              ? v >= edge
              : v > edge
        }
        return rule.below
          ? rule.equalAverage
            ? v <= avg
            : v < avg
          : rule.equalAverage
            ? v >= avg
            : v > avg
      }
      case 'duplicateValues':
      case 'uniqueValues': {
        const k = dupKey(v)
        if (!k) return false
        const n = dups(rule).get(k) ?? 0
        return rule.type === 'duplicateValues' ? n > 1 : n === 1
      }
      default:
        return false
    }
  }

  const scaleColor = (rule: CfRuleView, v: number): string | null => {
    const cs = rule.colorScale!
    if (cs.points.length < 2 || cs.colors.length < cs.points.length) return null
    const s = stats(rule)
    if (s.nums.length === 0) return null
    const at = cs.points.map((p) => vo(rule, p, s))
    if (at.some((x) => Number.isNaN(x))) return null
    if (v <= at[0]!) return cs.colors[0]!
    if (v >= at.at(-1)!) return cs.colors[at.length - 1]!
    for (let i = 0; i < at.length - 1; i++) {
      const lo = at[i]!
      const hi = at[i + 1]!
      if (v >= lo && v <= hi)
        return hi === lo
          ? cs.colors[i + 1]!
          : mix(cs.colors[i]!, cs.colors[i + 1]!, (v - lo) / (hi - lo))
    }
    return null
  }

  const barOf = (rule: CfRuleView, v: number): CfLook['bar'] | null => {
    const db = rule.dataBar!
    const s = stats(rule)
    if (s.nums.length === 0) return null
    const lo = vo(rule, db.min, s)
    const hi = vo(rule, db.max, s)
    if (Number.isNaN(lo) || Number.isNaN(hi)) return null
    const minL = Math.max(0, Math.min(100, db.minLength))
    const maxL = Math.max(minL, Math.min(100, db.maxLength))
    const base = {
      color: db.color,
      gradient: db.gradient,
      border: db.border,
      axisColor: db.axisColor,
    }
    if (db.axis !== 'none' && (lo < 0 || db.axis === 'middle') && db.negativeColor !== null) {
      // Excel 2010 bars with an axis: positive values grow right of it, negative ones left.
      const axis =
        db.axis === 'middle'
          ? 50
          : hi <= 0
            ? 100
            : (-Math.min(0, lo) / (hi - Math.min(0, lo))) * 100
      const posSpan = db.axis === 'middle' ? 50 : 100 - axis
      const negSpan = db.axis === 'middle' ? 50 : axis
      if (v >= 0) {
        const t = hi > 0 ? Math.min(1, v / hi) : 0
        return { ...base, from: axis, to: axis + posSpan * t, negative: false, axis }
      }
      const t = lo < 0 ? Math.min(1, v / lo) : 0
      return {
        ...base,
        color: db.negativeColor,
        from: axis - negSpan * t,
        to: axis,
        negative: true,
        axis,
      }
    }
    const t = hi === lo ? 1 : Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
    return { ...base, from: 0, to: minL + (maxL - minL) * t, negative: false, axis: null }
  }

  const iconOf = (rule: CfRuleView, v: number): CfLook['icon'] | null | 'none' => {
    const is = rule.iconSet!
    const n = ICON_SETS[is.set]
    const s = stats(rule)
    if (s.nums.length === 0) return null
    let idx = 0
    for (let k = Math.min(n, is.thresholds.length) - 1; k >= 1; k--) {
      const t = is.thresholds[k]!
      const x = vo(rule, t, s)
      if (Number.isNaN(x)) return null
      if (t.gte ? v >= x : v > x) {
        idx = k
        break
      }
    }
    // Icons go from the "worst" (index 0) up; reverse flips the order.
    const pos = is.reverse ? n - 1 - idx : idx
    const custom = is.custom?.[idx]
    if (custom) return custom.set === 'NoIcons' ? 'none' : { set: custom.set, index: custom.index }
    return { set: is.set, index: pos }
  }

  return (r: number, c: number): CfLook | null => {
    let look: CfLook | null = null
    const put = (k: keyof CfLook, v: unknown) => {
      look ??= {}
      if (look[k] === undefined) (look as Record<string, unknown>)[k] = v
    }
    for (const rule of rules) {
      if (!inRanges(rule.ranges, r, c)) continue
      if (rule.type === 'colorScale' || rule.type === 'dataBar' || rule.type === 'iconSet') {
        const v = value(r, c)
        if (typeof v !== 'number') continue
        if (rule.type === 'colorScale') {
          const col = scaleColor(rule, v)
          if (col) put('fill', col)
        } else if (rule.type === 'dataBar') {
          const bar = barOf(rule, v)
          if (bar) {
            put('bar', bar)
            if (!rule.dataBar!.showValue) put('hideValue', true)
          }
        } else {
          const icon = iconOf(rule, v)
          if (icon && icon !== 'none') put('icon', icon)
          if (icon && !rule.iconSet!.showValue) put('hideValue', true)
        }
        continue
      }
      if (!matches(rule, r, c)) continue
      const st = rule.style
      if (st)
        for (const [k, v] of Object.entries(st)) if (v !== undefined) put(k as keyof CfLook, v)
      if (rule.stopIfTrue) break
    }
    return look
  }
}

// ---------------------------------------------------------------------------
// Writing

/** A rule as people set it. */
export type CfRuleInput = {
  type: CfType
  /** cellIs */
  operator?: CfOperator
  /** cellIs: the value(s) or formula(s) compared with; expression: the formula (relative to the first cell). */
  formula1?: string
  formula2?: string
  /** containsText / notContainsText / beginsWith / endsWith */
  text?: string
  /** timePeriod */
  period?: TimePeriod
  /** top10 */
  rank?: number
  percent?: boolean
  bottom?: boolean
  /** aboveAverage */
  below?: boolean
  equalAverage?: boolean
  stdDev?: number
  /** The format a matching cell gets (not for scales, bars, icons). */
  style?: CfStyle
  stopIfTrue?: boolean
  /** colorScale: 2 or 3 points, low to high. */
  points?: Array<{ kind: CfvoKind; value?: string | null; color: string }>
  /** dataBar */
  bar?: {
    min?: { kind: CfvoKind; value?: string | null }
    max?: { kind: CfvoKind; value?: string | null }
    color: string
    gradient?: boolean
    showValue?: boolean
    border?: boolean
    negativeColor?: string
    axis?: 'automatic' | 'middle' | 'none'
  }
  /** iconSet */
  icons?: {
    set: IconSetName
    /** One per icon after the first, low to high (default: percent 33/67 …, as Excel). */
    thresholds?: Array<{ kind: CfvoKind; value: string; gte?: boolean }>
    reverse?: boolean
    showValue?: boolean
    /** Custom icons per slot (low to high), written in the Excel 2010 extension list. */
    custom?: Array<{ set: IconSetName | 'NoIcons'; index: number }>
  }
}

export type CfOp =
  | { op: 'cf_add'; sheet: string; range: string; rule: CfRuleInput }
  | { op: 'cf_update'; sheet: string; priority: number; range?: string; rule?: CfRuleInput }
  | { op: 'cf_delete'; sheet: string; priority: number }
  | { op: 'cf_clear'; sheet: string; range: string | null }
  | { op: 'cf_move'; sheet: string; priority: number; to: number }

const xmlns = (el: Element, prefix: string, ns: string) =>
  el.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, ns)

function guid(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('')
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`
}

/** The styles part's dxf index for `style` (an identical record is reused). */
function dxfIndex(wb: Workbook, style: CfStyle): number {
  const doc = stylesDoc(wb)
  const root = doc.documentElement!
  let list = kid(root, 'dxfs')
  if (!list) {
    list = make(doc, 'dxfs')
    insertInOrder(root, list, STYLESHEET_ORDER)
  }
  const dxf = make(doc, 'dxf')
  const hasFont = ['bold', 'italic', 'underline', 'strike', 'fontColor'].some(
    (k) => style[k as keyof CfStyle] !== undefined,
  )
  if (hasFont) {
    const font = make(doc, 'font')
    const flag = (name: string, on: boolean | undefined) => {
      if (on === undefined) return
      const e = make(doc, name)
      if (!on) e.setAttribute('val', '0')
      font.appendChild(e)
    }
    flag('b', style.bold)
    flag('i', style.italic)
    flag('strike', style.strike)
    if (style.underline !== undefined) {
      const u = make(doc, 'u')
      if (!style.underline) u.setAttribute('val', 'none')
      font.appendChild(u)
    }
    if (style.fontColor) {
      const c = make(doc, 'color')
      c.setAttribute('rgb', argb(style.fontColor))
      font.appendChild(c)
    }
    dxf.appendChild(font)
  }
  if (style.numFmt) {
    const nf = make(doc, 'numFmt')
    nf.setAttribute('numFmtId', String(numFmtIdFor(doc, style.numFmt)))
    nf.setAttribute('formatCode', style.numFmt)
    dxf.appendChild(nf)
  }
  if (style.fill) {
    const fill = make(doc, 'fill')
    const pf = make(doc, 'patternFill')
    const bg = make(doc, 'bgColor')
    bg.setAttribute('rgb', argb(style.fill))
    pf.appendChild(bg)
    fill.appendChild(pf)
    dxf.appendChild(fill)
  }
  if (style.border) {
    const border = make(doc, 'border')
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const e = make(doc, side)
      e.setAttribute('style', 'thin')
      const c = make(doc, 'color')
      c.setAttribute('rgb', argb(style.border))
      e.appendChild(c)
      border.appendChild(e)
    }
    dxf.appendChild(border)
  }
  const items = kids(list, 'dxf')
  const key = deepSignature(dxf)
  const same = items.findIndex((x) => deepSignature(x) === key)
  if (same >= 0) return same
  list.appendChild(dxf)
  list.setAttribute('count', String(items.length + 1))
  return items.length
}

/** A dxf's custom number format id: the one the stylesheet already has for that code, else a new one (≥ 164). */
function numFmtIdFor(doc: XMLDocument, code: string): number {
  const root = doc.documentElement!
  const fmts = all(root, 'numFmt')
  const hit = fmts.find((e) => e.getAttribute('formatCode') === code)
  if (hit) return Number(hit.getAttribute('numFmtId'))
  return Math.max(163, ...fmts.map((e) => Number(e.getAttribute('numFmtId') ?? 0))) + 1
}

function checkColor(c: string | undefined, what: string) {
  if (c !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(c))
    throw new XlsxError(`${what}: “${c}” is not a colour like #63BE7B.`)
}

function checkInput(rule: CfRuleInput) {
  if (!CF_TYPES.includes(rule.type))
    throw new XlsxError(`“${rule.type}” is not a kind of conditional format.`)
  const st = rule.style
  if (st) {
    checkColor(st.fontColor, 'Font colour')
    checkColor(st.fill, 'Fill')
    checkColor(st.border, 'Border')
  }
  const needsStyle = !['colorScale', 'dataBar', 'iconSet'].includes(rule.type)
  if (needsStyle && (!st || Object.values(st).every((v) => v === undefined)))
    throw new XlsxError('Say what a matching cell looks like (a fill, font colour, bold …).')
  switch (rule.type) {
    case 'cellIs':
      if (!rule.operator || !CF_OPERATORS.includes(rule.operator))
        throw new XlsxError('Say how to compare (greater than, between …).')
      if (!rule.formula1) throw new XlsxError('Give the value to compare with.')
      if ((rule.operator === 'between' || rule.operator === 'notBetween') && !rule.formula2)
        throw new XlsxError('“Between” needs two values.')
      break
    case 'expression':
      if (!rule.formula1) throw new XlsxError('Give the formula (like =$B2>100).')
      break
    case 'containsText':
    case 'notContainsText':
    case 'beginsWith':
    case 'endsWith':
      if (!rule.text) throw new XlsxError('Give the text to look for.')
      if (rule.text.length > 255) throw new XlsxError('The text can have at most 255 characters.')
      break
    case 'timePeriod':
      if (!rule.period || !TIME_PERIODS.includes(rule.period))
        throw new XlsxError('Say which dates (today, last 7 days …).')
      break
    case 'top10':
      if (
        !rule.rank ||
        !Number.isInteger(rule.rank) ||
        rule.rank < 1 ||
        rule.rank > (rule.percent ? 100 : 1000)
      )
        throw new XlsxError(
          rule.percent
            ? 'The percentage is a whole number from 1 to 100.'
            : 'The count is a whole number from 1 to 1000.',
        )
      break
    case 'aboveAverage':
      if (
        rule.stdDev !== undefined &&
        (!Number.isInteger(rule.stdDev) || rule.stdDev < 1 || rule.stdDev > 3)
      )
        throw new XlsxError('Standard deviations are 1, 2 or 3.')
      break
    case 'colorScale':
      if (!rule.points || (rule.points.length !== 2 && rule.points.length !== 3))
        throw new XlsxError('A colour scale has 2 or 3 points.')
      for (const p of rule.points) checkColor(p.color, 'Colour scale')
      break
    case 'dataBar':
      if (!rule.bar) throw new XlsxError('A data bar needs its colour.')
      checkColor(rule.bar.color, 'Bar')
      checkColor(rule.bar.negativeColor, 'Negative bar')
      break
    case 'iconSet':
      if (!rule.icons || !(rule.icons.set in ICON_SETS)) throw new XlsxError('Say which icon set.')
      if (rule.icons.thresholds && rule.icons.thresholds.length !== ICON_SETS[rule.icons.set] - 1)
        throw new XlsxError(`${rule.icons.set} needs ${ICON_SETS[rule.icons.set] - 1} thresholds.`)
      if (rule.icons.custom) {
        const expected = ICON_SETS[rule.icons.set]
        if (rule.icons.custom.length !== expected)
          throw new XlsxError(`${rule.icons.set} needs ${expected} custom icons.`)
        for (const c of rule.icons.custom) {
          if (c.set !== 'NoIcons' && !(c.set in ICON_SETS))
            throw new XlsxError(`“${c.set}” is not an icon set.`)
          const max = c.set === 'NoIcons' ? 1 : ICON_SETS[c.set]
          if (!Number.isInteger(c.index) || c.index < 0 || c.index >= max)
            throw new XlsxError(`Icon index ${c.index} is out of range for ${c.set}.`)
        }
      }
      break
  }
}

function cfvoEl(
  doc: XMLDocument,
  kind: CfvoKind,
  value: string | null | undefined,
  x14: boolean,
  gte?: boolean,
): Element {
  const el = x14 ? doc.createElementNS(NS_X14, 'x14:cfvo') : make(doc, 'cfvo')
  el.setAttribute('type', kind)
  if (gte === false) el.setAttribute('gte', '0')
  const needs = kind !== 'min' && kind !== 'max' && kind !== 'autoMin' && kind !== 'autoMax'
  if (needs) {
    if (value === null || value === undefined || value === '')
      throw new XlsxError(`A ${kind} point needs its value.`)
    const v = value.replace(/^=/, '')
    if (x14) {
      const f = doc.createElementNS(NS_XM, 'xm:f')
      setText(doc, f, v)
      el.appendChild(f)
    } else el.setAttribute('val', v)
  }
  return el
}

function colorEl(doc: XMLDocument, local: string, color: string, ns?: string): Element {
  const el = ns ? doc.createElementNS(ns, `x14:${local}`) : make(doc, local)
  el.setAttribute('rgb', argb(color))
  return el
}

const DEFAULT_THRESHOLDS: Record<number, number[]> = {
  3: [33, 67],
  4: [25, 50, 75],
  5: [20, 40, 60, 80],
}

/** The worksheet's x14 conditional formattings element (made when missing). */
function ensureX14(doc: XMLDocument): Element {
  const root = doc.documentElement!
  let lst = kid(root, 'extLst')
  if (!lst) {
    lst = make(doc, 'extLst')
    insertInOrder(root, lst, WORKSHEET_ORDER)
  }
  let ext = kids(lst, 'ext').find((e) => e.getAttribute('uri') === X14_CF_URI)
  if (!ext) {
    ext = make(doc, 'ext')
    xmlns(ext, 'x14', NS_X14)
    ext.setAttribute('uri', X14_CF_URI)
    lst.insertBefore(ext, lst.firstChild)
  }
  let cfs = kid(ext, 'conditionalFormattings', NS_X14)
  if (!cfs) {
    cfs = doc.createElementNS(NS_X14, 'x14:conditionalFormattings')
    ext.appendChild(cfs)
  }
  return cfs
}

function x14Formatting(doc: XMLDocument, ranges: Range[]): { cf: Element; done: () => void } {
  const cf = doc.createElementNS(NS_X14, 'x14:conditionalFormatting')
  xmlns(cf, 'xm', NS_XM)
  return {
    cf,
    done: () => {
      const sq = doc.createElementNS(NS_XM, 'xm:sqref')
      setText(doc, sq, sqrefText(ranges))
      cf.appendChild(sq)
      ensureX14(doc).appendChild(cf)
    },
  }
}

/** Writes rule `rule` over `ranges` with `priority`, as Excel writes it. */
function writeRule(
  wb: Workbook,
  doc: XMLDocument,
  ranges: Range[],
  rule: CfRuleInput,
  priority: number,
  where: string,
) {
  checkInput(rule)
  const root = doc.documentElement!
  const anchor = cellName(anchorOf(ranges))
  if (rule.type === 'iconSet' && (X14_ONLY_SETS.has(rule.icons!.set) || rule.icons!.custom)) {
    const { cf, done } = x14Formatting(doc, ranges)
    const el = doc.createElementNS(NS_X14, 'x14:cfRule')
    el.setAttribute('type', 'iconSet')
    el.setAttribute('priority', String(priority))
    el.setAttribute('id', guid())
    el.appendChild(iconSetEl(doc, rule, true))
    cf.appendChild(el)
    done()
    return
  }
  const cf = make(doc, 'conditionalFormatting')
  cf.setAttribute('sqref', sqrefText(ranges))
  const el = make(doc, 'cfRule')
  el.setAttribute('type', rule.type)
  if (rule.style && !['colorScale', 'dataBar', 'iconSet'].includes(rule.type))
    el.setAttribute('dxfId', String(dxfIndex(wb, rule.style)))
  el.setAttribute('priority', String(priority))
  if (rule.stopIfTrue) el.setAttribute('stopIfTrue', '1')
  const formula = (text: string) => {
    const f = make(doc, 'formula')
    setText(doc, f, text)
    el.appendChild(f)
  }
  switch (rule.type) {
    case 'cellIs':
      el.setAttribute('operator', rule.operator!)
      formula(toFileFormula(rule.formula1!, where))
      if (rule.operator === 'between' || rule.operator === 'notBetween')
        formula(toFileFormula(rule.formula2!, where))
      break
    case 'expression':
      formula(toFileFormula(rule.formula1!, where))
      break
    case 'containsText':
    case 'notContainsText':
    case 'beginsWith':
    case 'endsWith':
      el.setAttribute('operator', rule.type === 'notContainsText' ? 'notContains' : rule.type)
      el.setAttribute('text', rule.text!)
      formula(standardFormula(rule.type, anchor, rule.text!, null)!)
      break
    case 'containsBlanks':
    case 'notContainsBlanks':
    case 'containsErrors':
    case 'notContainsErrors':
      formula(standardFormula(rule.type, anchor, null, null)!)
      break
    case 'timePeriod':
      el.setAttribute('timePeriod', rule.period!)
      formula(standardFormula(rule.type, anchor, null, rule.period!)!)
      break
    case 'top10':
      if (rule.percent) el.setAttribute('percent', '1')
      if (rule.bottom) el.setAttribute('bottom', '1')
      el.setAttribute('rank', String(rule.rank))
      break
    case 'aboveAverage':
      if (rule.below) el.setAttribute('aboveAverage', '0')
      if (rule.equalAverage) el.setAttribute('equalAverage', '1')
      if (rule.stdDev) el.setAttribute('stdDev', String(rule.stdDev))
      break
    case 'duplicateValues':
    case 'uniqueValues':
      break
    case 'colorScale': {
      const cs = make(doc, 'colorScale')
      for (const p of rule.points!) cs.appendChild(cfvoEl(doc, p.kind, p.value, false))
      for (const p of rule.points!) cs.appendChild(colorEl(doc, 'color', p.color))
      el.appendChild(cs)
      break
    }
    case 'dataBar': {
      const b = rule.bar!
      const db = make(doc, 'dataBar')
      if (b.showValue === false) db.setAttribute('showValue', '0')
      const minK = b.min?.kind ?? 'min'
      const maxK = b.max?.kind ?? 'max'
      // Excel 2007 knows no automatic ends: min/max there, autoMin/autoMax in the extension.
      db.appendChild(cfvoEl(doc, minK === 'autoMin' ? 'min' : minK, b.min?.value, false))
      db.appendChild(cfvoEl(doc, maxK === 'autoMax' ? 'max' : maxK, b.max?.value, false))
      db.appendChild(colorEl(doc, 'color', b.color))
      el.appendChild(db)
      const id = guid()
      const lst = make(doc, 'extLst')
      const ext = make(doc, 'ext')
      xmlns(ext, 'x14', NS_X14)
      ext.setAttribute('uri', X14_ID_URI)
      const idEl = doc.createElementNS(NS_X14, 'x14:id')
      setText(doc, idEl, id)
      ext.appendChild(idEl)
      lst.appendChild(ext)
      el.appendChild(lst)
      const { cf: xcf, done } = x14Formatting(doc, ranges)
      const xr = doc.createElementNS(NS_X14, 'x14:cfRule')
      xr.setAttribute('type', 'dataBar')
      xr.setAttribute('id', id)
      const xdb = doc.createElementNS(NS_X14, 'x14:dataBar')
      xdb.setAttribute('minLength', '0')
      xdb.setAttribute('maxLength', '100')
      if (b.gradient === false) xdb.setAttribute('gradient', '0')
      if (b.border) xdb.setAttribute('border', '1')
      if (b.axis && b.axis !== 'automatic') xdb.setAttribute('axisPosition', b.axis)
      if (b.border) xdb.setAttribute('negativeBarBorderColorSameAsPositive', '0')
      xdb.appendChild(cfvoEl(doc, minK === 'min' ? 'autoMin' : minK, b.min?.value, true))
      xdb.appendChild(cfvoEl(doc, maxK === 'max' ? 'autoMax' : maxK, b.max?.value, true))
      if (b.border) xdb.appendChild(colorEl(doc, 'borderColor', b.color, NS_X14))
      xdb.appendChild(colorEl(doc, 'negativeFillColor', b.negativeColor ?? '#FF0000', NS_X14))
      if (b.border)
        xdb.appendChild(colorEl(doc, 'negativeBorderColor', b.negativeColor ?? '#FF0000', NS_X14))
      xdb.appendChild(colorEl(doc, 'axisColor', '#000000', NS_X14))
      xr.appendChild(xdb)
      xcf.appendChild(xr)
      done()
      break
    }
    case 'iconSet':
      el.appendChild(iconSetEl(doc, rule, false))
      break
  }
  cf.appendChild(el)
  // Excel lists conditional formats in the order they were made; a new block goes after the others.
  const last = kids(root, 'conditionalFormatting').at(-1)
  if (last) root.insertBefore(cf, last.nextSibling)
  else insertInOrder(root, cf, WORKSHEET_ORDER)
}

function iconSetEl(doc: XMLDocument, rule: CfRuleInput, x14: boolean): Element {
  const ic = rule.icons!
  const n = ICON_SETS[ic.set]
  const el = x14 ? doc.createElementNS(NS_X14, 'x14:iconSet') : make(doc, 'iconSet')
  if (ic.set !== '3TrafficLights1') el.setAttribute('iconSet', ic.set)
  if (ic.showValue === false) el.setAttribute('showValue', '0')
  if (ic.reverse) el.setAttribute('reverse', '1')
  el.appendChild(cfvoEl(doc, 'percent', '0', x14))
  const th =
    ic.thresholds ??
    DEFAULT_THRESHOLDS[n]!.map((v) => ({
      kind: 'percent' as CfvoKind,
      value: String(v),
      gte: true,
    }))
  for (const t of th) el.appendChild(cfvoEl(doc, t.kind, t.value, x14, t.gte))
  if (x14 && ic.custom) {
    el.setAttribute('custom', '1')
    for (const c of ic.custom) {
      const iconEl = doc.createElementNS(NS_X14, 'x14:cfIcon')
      iconEl.setAttribute('iconSet', c.set)
      iconEl.setAttribute('iconId', String(c.index))
      el.appendChild(iconEl)
    }
  }
  return el
}

type RuleEl = { el: Element; container: Element; x14: boolean }

/** Every rule element of the sheet with its priority (main and extension lists). */
function ruleEls(root: Element): RuleEl[] {
  const out: RuleEl[] = []
  for (const cf of kids(root, 'conditionalFormatting'))
    for (const el of kids(cf, 'cfRule')) out.push({ el, container: cf, x14: false })
  const x14 = x14Formattings(root)
  for (const cf of x14 ? kids(x14, 'conditionalFormatting', NS_X14) : [])
    for (const el of kids(cf, 'cfRule', NS_X14))
      if (el.getAttribute('priority')) out.push({ el, container: cf, x14: true })
  return out
}

function findRule(root: Element, priority: number): RuleEl {
  const hit = ruleEls(root).find((r) => Number(r.el.getAttribute('priority')) === priority)
  if (!hit) throw new XlsxError(`This sheet has no conditional format rule ${priority}.`)
  return hit
}

/** Removes a rule (and the extension data bar it links to); empty containers go. */
function removeRule(root: Element, r: RuleEl) {
  const linked = r.x14 ? null : textOf(findX14Id(r.el))
  r.container.removeChild(r.el)
  dropEmpty(r.container, r.x14)
  if (linked) {
    const x14 = x14Formattings(root)
    for (const cf of x14 ? kids(x14, 'conditionalFormatting', NS_X14) : [])
      for (const el of kids(cf, 'cfRule', NS_X14))
        if (el.getAttribute('id') === linked) {
          cf.removeChild(el)
          dropEmpty(cf, true)
        }
  }
  tidyX14(root)
}

function dropEmpty(container: Element, x14: boolean) {
  if (kids(container, 'cfRule', x14 ? NS_X14 : undefined).length > 0) return
  container.parentNode?.removeChild(container)
}

function tidyX14(root: Element) {
  const x14 = x14Formattings(root)
  if (!x14 || kids(x14, 'conditionalFormatting', NS_X14).length > 0) return
  const ext = x14.parentNode as Element
  const lst = ext.parentNode as Element
  lst.removeChild(ext)
  if (kids(lst, 'ext').length === 0) root.removeChild(lst)
}

function sqrefOf(r: RuleEl): Range[] {
  return r.x14
    ? parseSqref(textOf(kid(r.container, 'sqref', NS_XM)))
    : parseSqref(r.container.getAttribute('sqref') ?? '')
}

/** A rule's formulas, re-anchored when its first cell moved (they stay relative to it). */
function reanchor(doc: XMLDocument, r: RuleEl, from: Range[], to: Range[]) {
  const a = cellName(anchorOf(from))
  const b = cellName(anchorOf(to))
  if (a === b) return
  const fs = r.x14 ? kids(r.el, 'f', NS_XM) : kids(r.el, 'formula')
  for (const f of fs) setText(doc, f, translateFormula(textOf(f), a, b))
}

/** Gives a rule its own container with `ranges` (a container may hold several rules). */
function setRanges(doc: XMLDocument, r: RuleEl, ranges: Range[]) {
  const linked = r.x14 ? null : textOf(findX14Id(r.el))
  const own = r.container
  if (r.x14) {
    const sq = kid(own, 'sqref', NS_XM)
    if (kids(own, 'cfRule', NS_X14).length === 1 && sq) setText(doc, sq, sqrefText(ranges))
    else {
      const { cf, done } = x14Formatting(doc, ranges)
      own.removeChild(r.el)
      cf.appendChild(r.el)
      done()
    }
  } else if (kids(own, 'cfRule').length === 1) own.setAttribute('sqref', sqrefText(ranges))
  else {
    const cf = make(doc, 'conditionalFormatting')
    cf.setAttribute('sqref', sqrefText(ranges))
    own.removeChild(r.el)
    cf.appendChild(r.el)
    own.parentNode!.insertBefore(cf, own.nextSibling)
  }
  if (linked) {
    const x14 = x14Formattings(doc.documentElement!)
    for (const cf of x14 ? kids(x14, 'conditionalFormatting', NS_X14) : [])
      if (kids(cf, 'cfRule', NS_X14).some((e) => e.getAttribute('id') === linked)) {
        const sq = kid(cf, 'sqref', NS_XM)
        if (sq) setText(doc, sq, sqrefText(ranges))
      }
  }
}

export function runCfOp(wb: Workbook, op: CfOp): string[] {
  const info = wb.requireWorksheet(op.sheet)
  const doc = sheetDoc(wb, info)
  const root = doc.documentElement!
  const where = `${info.name} conditional format`
  switch (op.op) {
    case 'cf_add': {
      const ranges = requireSqref(op.range)
      // A new rule goes on top (priority 1); the others move down one.
      for (const r of ruleEls(root))
        r.el.setAttribute('priority', String(Number(r.el.getAttribute('priority')) + 1))
      writeRule(wb, doc, ranges, op.rule, 1, where)
      break
    }
    case 'cf_update': {
      const r = findRule(root, op.priority)
      const ranges = op.range ? requireSqref(op.range) : sqrefOf(r)
      if (op.rule) {
        const stop = op.rule.stopIfTrue
        removeRule(root, r)
        writeRule(wb, doc, ranges, { ...op.rule, stopIfTrue: stop }, op.priority, where)
      } else if (op.range) {
        reanchor(doc, r, sqrefOf(r), ranges)
        setRanges(doc, r, ranges)
      }
      break
    }
    case 'cf_delete': {
      const r = findRule(root, op.priority)
      removeRule(root, r)
      renumber(root)
      break
    }
    case 'cf_clear': {
      const all = ruleEls(root)
      if (all.length === 0) return []
      if (op.range === null) for (const r of all) removeRule(root, r)
      else {
        const cuts = requireSqref(op.range)
        for (const r of all) {
          const from = sqrefOf(r)
          const rest = subtractAll(from, cuts)
          if (rest.length === 0) removeRule(root, r)
          else if (sqrefText(rest) !== sqrefText(from)) {
            reanchor(doc, r, from, rest)
            setRanges(doc, r, rest)
          }
        }
      }
      renumber(root)
      break
    }
    case 'cf_move': {
      const list = ruleEls(root).sort(
        (a, b) => Number(a.el.getAttribute('priority')) - Number(b.el.getAttribute('priority')),
      )
      const i = list.findIndex((r) => Number(r.el.getAttribute('priority')) === op.priority)
      if (i < 0) throw new XlsxError(`This sheet has no conditional format rule ${op.priority}.`)
      const to = Math.max(1, Math.min(list.length, op.to)) - 1
      const [moved] = list.splice(i, 1)
      list.splice(to, 0, moved!)
      list.forEach((r, k) => r.el.setAttribute('priority', String(k + 1)))
      break
    }
  }
  finishSheet(wb, info, doc)
  return [info.name]
}

/** Priorities 1…n again in their order (after a delete). */
function renumber(root: Element) {
  ruleEls(root)
    .sort((a, b) => Number(a.el.getAttribute('priority')) - Number(b.el.getAttribute('priority')))
    .forEach((r, k) => r.el.setAttribute('priority', String(k + 1)))
}

/** The rule as a tool or the rules panel edits it (the inverse of writing, for "edit"). */
export function inputOf(r: CfRuleView): CfRuleInput {
  const base: CfRuleInput = { type: r.type, stopIfTrue: r.stopIfTrue }
  if (r.style) base.style = r.style
  switch (r.type) {
    case 'cellIs':
      return {
        ...base,
        operator: r.operator ?? 'equal',
        formula1: r.formulas[0],
        formula2: r.formulas[1],
      }
    case 'expression':
      return { ...base, formula1: r.formulas[0] }
    case 'containsText':
    case 'notContainsText':
    case 'beginsWith':
    case 'endsWith':
      return { ...base, text: r.text ?? '' }
    case 'timePeriod':
      return { ...base, period: r.period ?? 'today' }
    case 'top10':
      return { ...base, rank: r.rank ?? 10, percent: r.percent, bottom: r.bottom }
    case 'aboveAverage':
      return {
        ...base,
        below: r.below,
        equalAverage: r.equalAverage,
        stdDev: r.stdDev ?? undefined,
      }
    case 'colorScale':
      return {
        type: r.type,
        points: (r.colorScale?.points ?? []).map((p, i) => ({
          kind: p.kind,
          value: p.value,
          color: r.colorScale!.colors[i] ?? '#000000',
        })),
      }
    case 'dataBar': {
      const d = r.dataBar!
      return {
        type: r.type,
        bar: {
          min: { kind: d.min.kind, value: d.min.value },
          max: { kind: d.max.kind, value: d.max.value },
          color: d.color,
          gradient: d.gradient,
          showValue: d.showValue,
          border: d.border !== null,
          negativeColor: d.negativeColor ?? undefined,
          axis: d.axis,
        },
      }
    }
    case 'iconSet': {
      const s = r.iconSet!
      const custom = s.custom?.filter(
        (c): c is { set: IconSetName | 'NoIcons'; index: number } => c !== null,
      )
      return {
        type: r.type,
        icons: {
          set: s.set,
          thresholds: s.thresholds
            .slice(1)
            .map((t) => ({ kind: t.kind, value: t.value ?? '0', gte: t.gte })),
          reverse: s.reverse,
          showValue: s.showValue,
          ...(custom && custom.length === ICON_SETS[s.set] ? { custom } : {}),
        },
      }
    }
    default:
      return base
  }
}
