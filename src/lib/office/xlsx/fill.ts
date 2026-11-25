import type { OpResult } from './ops'
import type { CellContent } from './sheet-xml'
import { getFormatDateInfo, isDateFormat } from 'numfmt'
import { needsDynamicArray } from './calc-static'
import { moveFormula, writePlacements, type Placement } from './clip'
import { cellKey, cellName, rangeName, requireRange, type Range } from './ref'
import { richCells, type RichRun } from './rich-text'
import { XlsxError, type CellData, type CellValue, type SheetData, type Workbook } from './workbook'

/**
 * The fill handle and Home ▸ Fill (Excel's AutoFill): the cells of `source`
 * continued over `target` (which holds the source and runs on from one of
 * its edges), each line on its own — a column when filling down or up, a
 * row when filling right or left.
 *
 * `auto` is what dragging the handle does: one number is copied, two or
 * more continue their linear trend (least squares, as Excel); dates step by
 * day, or by month/year when the source does; a time steps by the hour;
 * built-in lists (weekdays, months, in English and German) and text ending
 * in a number ("Item 1", "Q1" … "Q4") count on; anything else (formulas with
 * their relative references, other text, true/false) repeats as a pattern.
 * The other series are Home ▸ Fill ▸ Series: copy, linear and growth with a
 * step, and days, weekdays, months, years for dates. Formats repeat with
 * their cells. Filling up or left runs the series backwards.
 */

export const FILL_SERIES = [
  'auto',
  'copy',
  'linear',
  'growth',
  'days',
  'weekdays',
  'months',
  'years',
] as const
export type FillSeries = (typeof FILL_SERIES)[number]

export type FillOp = {
  op: 'fill'
  sheet: string
  /** The cells to continue, like A1:A2. */
  source: string
  /** The source plus the cells to fill, like A1:A10 (one direction only). */
  target: string
  series?: FillSeries
  /** The step (linear: added, growth: multiplied; dates: days/months/years); default from the source, else 1. */
  step?: number
  /** Series stop at this value (cells past it stay as they are). */
  stop?: number
  /** Optional custom text lists (in addition to Excel's built-in weekday/month lists). */
  customLists?: string[][]
}

export type FillDirection = 'down' | 'up' | 'right' | 'left'

export const MAX_FILL_CELLS = 100_000

/** Where the target runs on from the source. */
export function fillDirection(source: Range, target: Range): FillDirection | null {
  const sameCols = source.left === target.left && source.right === target.right
  const sameRows = source.top === target.top && source.bottom === target.bottom
  if (sameCols && source.top === target.top && target.bottom > source.bottom) return 'down'
  if (sameCols && source.bottom === target.bottom && target.top < source.top) return 'up'
  if (sameRows && source.left === target.left && target.right > source.right) return 'right'
  if (sameRows && source.right === target.right && target.left < source.left) return 'left'
  return null
}

// ---------------------------------------------------------------------------
// Lists (Excel's built-in custom lists, English and German)

const LISTS: string[][] = [
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  ['Jan', 'Feb', 'Mrz', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
  [
    'Januar',
    'Februar',
    'März',
    'April',
    'Mai',
    'Juni',
    'Juli',
    'August',
    'September',
    'Oktober',
    'November',
    'Dezember',
  ],
]

type ListHit = { list: string[]; index: number; casing: 'upper' | 'lower' | 'title' }

function listItem(text: string, lists: string[][] = LISTS): ListHit | null {
  const t = text.trim()
  if (t === '') return null
  const lower = t.toLowerCase()
  for (const list of lists) {
    const index = list.findIndex((x) => x.toLowerCase() === lower)
    if (index < 0) continue
    const casing =
      t === t.toUpperCase() && t !== t.toLowerCase()
        ? 'upper'
        : t === t.toLowerCase()
          ? 'lower'
          : 'title'
    return { list, index, casing }
  }
  return null
}

function cased(word: string, casing: ListHit['casing']): string {
  if (casing === 'upper') return word.toUpperCase()
  if (casing === 'lower') return word.toLowerCase()
  return word
}

// ---------------------------------------------------------------------------
// Text with a number

type Numbered = { prefix: string; n: number; digits: number; suffix: string }

/** "Item 7" → Item, 7; "Q1" → Q, 1. The last run of digits counts (Excel); a number alone is not text. */
function numbered(text: string): Numbered | null {
  const m = /^(.*?)(\d+)(\D*)$/.exec(text)
  if (!m || (m[1] === '' && m[3] === '')) return null
  return { prefix: m[1]!, n: Number(m[2]), digits: m[2]!.length, suffix: m[3]! }
}

const isQuarter = (p: Numbered) => /^(q|qtr|quarter|quartal) ?$/i.test(p.prefix) && p.suffix === ''

function writeNumbered(p: Numbered, n: number): string {
  let num = n
  if (isQuarter(p)) num = ((((n - 1) % 4) + 4) % 4) + 1
  const abs = String(Math.abs(num)).padStart(p.digits, '0')
  return `${p.prefix}${num < 0 ? '-' : ''}${abs}${p.suffix}`
}

// ---------------------------------------------------------------------------
// Dates (serial numbers, 1900 date system; date1904 is shifted in and out)

function toYmd(serial: number): { y: number; m: number; d: number; frac: number } {
  const days = Math.floor(serial)
  const ms = Date.UTC(1899, 11, 30) + days * 86_400_000
  const dt = new Date(ms)
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    frac: serial - days,
  }
}

function fromYmd(y: number, m: number, d: number): number {
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function isMonthEnd(serial: number): boolean {
  const { y, m, d } = toYmd(serial)
  return d === lastDayOfMonth(y, m)
}

/** Excel's EDATE: the same day `months` later, or that month's last day (`monthEnd` pins to month ends). */
export function addMonths(serial: number, months: number, monthEnd = false): number {
  const { y, m, d, frac } = toYmd(serial)
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const last = lastDayOfMonth(ny, nm)
  return fromYmd(ny, nm, monthEnd ? last : Math.min(d, last)) + frac
}

/** Weekday steps: Saturday and Sunday are skipped. */
export function addWeekdays(serial: number, days: number): number {
  let s = Math.floor(serial)
  const frac = serial - s
  const dir = days < 0 ? -1 : 1
  let left = Math.abs(days)
  while (left > 0) {
    s += dir
    const wd = new Date(Date.UTC(1899, 11, 30) + s * 86_400_000).getUTCDay()
    if (wd !== 0 && wd !== 6) left--
  }
  return s + frac
}

/** Months between two dates when they are on the same day of the month (or both month ends), else null. */
function monthsBetween(a: number, b: number): number | null {
  const x = toYmd(a)
  const y = toYmd(b)
  if (x.frac !== y.frac) return null
  const lastX = new Date(Date.UTC(x.y, x.m, 0)).getUTCDate()
  const lastY = new Date(Date.UTC(y.y, y.m, 0)).getUTCDate()
  if (x.d !== y.d && !(x.d === lastX && y.d === lastY)) return null
  const n = (y.y - x.y) * 12 + (y.m - x.m)
  return n === 0 ? null : n
}

// ---------------------------------------------------------------------------
// Series of one line

/** A source cell as the series sees it. */
export type SeedCell = {
  value: CellValue
  formula: string | null
  style: number
  date: boolean
  time: boolean
  runs?: RichRun[]
}

/** The value (or "pattern": copy the source cell at that index, with its formula moved) for each new cell. */
export type Generated =
  { kind: 'value'; value: CellValue; from: number } | { kind: 'copy'; from: number }

const tidy = (v: number) => Number(v.toPrecision(15))

/** Least-squares line through (0, ys[0]) … (n−1, ys[n−1]). */
function trend(ys: number[]): { a: number; b: number } {
  const n = ys.length
  const mx = (n - 1) / 2
  const my = ys.reduce((s, y) => s + y, 0) / n
  let num = 0
  let den = 0
  ys.forEach((y, x) => {
    num += (x - mx) * (y - my)
    den += (x - mx) ** 2
  })
  const b = den === 0 ? 0 : num / den
  return { a: my - b * mx, b }
}

/**
 * The `count` cells after `seed` (seed in fill order: its last cell is next
 * to the first new one).
 */
export function seriesOf(
  seed: SeedCell[],
  count: number,
  series: FillSeries = 'auto',
  opts: { step?: number; stop?: number; customLists?: string[][] } = {},
): Generated[] {
  const allLists = opts.customLists?.length ? [...LISTS, ...opts.customLists] : LISTS
  const m = seed.length
  const out: Generated[] = []
  const pattern = (inc: boolean) => {
    for (let k = 1; k <= count; k++) {
      const from = (k - 1) % m
      const cycle = Math.floor((k - 1) / m) + 1
      const s = seed[from]!
      if (inc && s.formula === null && typeof s.value === 'string') {
        const li = listItem(s.value, allLists)
        if (li) {
          const word = li.list[(li.index + cycle) % li.list.length]!
          out.push({ kind: 'value', value: cased(word, li.casing), from })
          continue
        }
        const nb = numbered(s.value)
        if (nb) {
          out.push({ kind: 'value', value: writeNumbered(nb, nb.n + cycle), from })
          continue
        }
      }
      out.push({ kind: 'copy', from })
    }
    return out
  }
  if (series === 'copy') return pattern(false)
  const literals = seed.every((s) => s.formula === null && typeof s.value === 'number')
  const nums = literals ? seed.map((s) => s.value as number) : []
  const last = nums[m - 1]!
  const stopped = (v: number, step: number) =>
    opts.stop !== undefined && (step >= 0 ? v > opts.stop : v < opts.stop)
  const emit = (f: (k: number) => number, step: number) => {
    for (let k = 1; k <= count; k++) {
      const v = tidy(f(k))
      if (stopped(v, step)) break
      out.push({ kind: 'value', value: v, from: (k - 1) % m })
    }
    return out
  }
  if (series !== 'auto') {
    if (!literals)
      throw new XlsxError(
        'A series needs numbers or dates in the first cells (formulas and text are copied by AutoFill).',
      )
    const diff = m >= 2 ? nums[m - 1]! - nums[m - 2]! : 1
    switch (series) {
      case 'linear': {
        const step = opts.step ?? diff
        return emit((k) => last + k * step, step)
      }
      case 'growth': {
        const step = opts.step ?? (m >= 2 && nums[m - 2] !== 0 ? nums[m - 1]! / nums[m - 2]! : 1)
        return emit((k) => last * step ** k, step >= 1 ? 1 : -1)
      }
      case 'days': {
        const step = opts.step ?? 1
        return emit((k) => last + k * step, step)
      }
      case 'weekdays': {
        const step = opts.step ?? 1
        return emit((k) => addWeekdays(last, k * step), step)
      }
      case 'months': {
        const step = opts.step ?? 1
        const monthEnd = nums.every(isMonthEnd)
        return emit((k) => addMonths(last, k * step, monthEnd), step)
      }
      case 'years': {
        const step = opts.step ?? 1
        const monthEnd = nums.every(isMonthEnd)
        return emit((k) => addMonths(last, 12 * k * step, monthEnd), step)
      }
    }
  }
  // AutoFill.
  if (literals) {
    const date = seed[0]!.date
    if (m === 1) {
      if (seed[0]!.time) return emit((k) => last + k / 24, 1)
      if (date) return emit((k) => last + k, 1)
      return pattern(false)
    }
    if (date) {
      const months = nums.slice(1).map((v, i) => monthsBetween(nums[i]!, v))
      const step = months[0]
      if (step != null && months.every((x) => x === step)) {
        const monthEnd = nums.every(isMonthEnd)
        return emit((k) => addMonths(last, k * step, monthEnd), step)
      }
    }
    const { a, b } = trend(nums)
    return emit((k) => a + b * (m - 1 + k), b)
  }
  const texts = seed.every((s) => s.formula === null && typeof s.value === 'string')
  if (texts) {
    const strs = seed.map((s) => s.value as string)
    const first = listItem(strs[0]!, allLists)
    const hits = first ? strs.map((t) => listItem(t, [first.list])) : []
    if (first && hits.every(Boolean)) {
      const len = first.list.length
      const step = m >= 2 ? (((hits[1]!.index - hits[0]!.index) % len) + len) % len || 1 : 1
      const lastHit = hits[m - 1]!
      for (let k = 1; k <= count; k++) {
        const word = first.list[(lastHit.index + k * step) % len]!
        out.push({ kind: 'value', value: cased(word, first.casing), from: (k - 1) % m })
      }
      return out
    }
    const parts = strs.map(numbered)
    const p0 = parts[0]
    if (p0 && parts.every((p) => p && p.prefix === p0.prefix && p.suffix === p0.suffix)) {
      const ns = parts.map((p) => p!.n)
      const step = m >= 2 ? ns[m - 1]! - ns[m - 2]! : 1
      const lastN = ns[m - 1]!
      for (let k = 1; k <= count; k++)
        out.push({
          kind: 'value',
          value: writeNumbered(parts[m - 1]!, lastN + k * step),
          from: (k - 1) % m,
        })
      return out
    }
  }
  return pattern(true)
}

// ---------------------------------------------------------------------------
// The operation

function seedOf(
  wb: Workbook,
  data: SheetData,
  rich: Map<number, RichRun[]>,
  row: number,
  col: number,
): SeedCell {
  const cell: CellData | undefined = data.cells.get(cellKey(row, col))
  const st = wb.styles().xf(cell?.style ?? 0)
  const date = st.numFmtId !== 0 && isDateFormat(st.numFmt)
  let time = false
  if (date) {
    const info = getFormatDateInfo(st.numFmt) as { year?: boolean; month?: boolean; day?: boolean }
    time = !info.year && !info.month && !info.day
  }
  const rawVal = cell?.formula ? null : (cell?.value ?? null)
  const value = wb.date1904 && date && !time && typeof rawVal === 'number' ? rawVal + 1462 : rawVal
  const runs = !cell?.formula ? rich.get(cellKey(row, col)) : undefined
  return {
    value,
    formula: cell?.formula && !cell.inArrayOf ? cell.formula : null,
    style: cell?.style ?? 0,
    date,
    time,
    ...(runs ? { runs } : {}),
  }
}

export function runFill(wb: Workbook, op: FillOp): OpResult {
  const info = wb.requireWorksheet(op.sheet)
  const source = requireRange(op.source)
  const target = requireRange(op.target)
  const series = op.series ?? 'auto'
  if (!FILL_SERIES.includes(series)) throw new XlsxError(`“${series}” is not a kind of series.`)
  const dir = fillDirection(source, target)
  if (!dir)
    throw new XlsxError(
      `${rangeName(target)} must hold ${rangeName(source)} and run on from one of its edges (down, up, right or left).`,
    )
  const n = (target.bottom - target.top + 1) * (target.right - target.left + 1)
  if (n > MAX_FILL_CELLS) throw new XlsxError(`Fill at most ${MAX_FILL_CELLS} cells at a time.`)
  if (op.step !== undefined && !Number.isFinite(op.step))
    throw new XlsxError('The step must be a number.')
  const data = wb.sheet(info.name)
  const rich = richCells(wb, info.name)
  const vertical = dir === 'down' || dir === 'up'
  const lines = vertical
    ? Array.from({ length: source.right - source.left + 1 }, (_, i) => source.left + i)
    : Array.from({ length: source.bottom - source.top + 1 }, (_, i) => source.top + i)
  const seedLen = vertical ? source.bottom - source.top + 1 : source.right - source.left + 1
  const count = vertical
    ? target.bottom - target.top + 1 - seedLen
    : target.right - target.left + 1 - seedLen
  const placements: Placement[] = []
  for (const line of lines) {
    // Seed positions in fill order (the last is next to the new cells).
    const pos = Array.from({ length: seedLen }, (_, i) => {
      const k = dir === 'down' || dir === 'right' ? i : seedLen - 1 - i
      return vertical ? { row: source.top + k, col: line } : { row: line, col: source.left + k }
    })
    const seed = pos.map((p) => seedOf(wb, data, rich, p.row, p.col))
    const gen = seriesOf(seed, count, series, {
      ...(op.step !== undefined ? { step: op.step } : {}),
      ...(op.stop !== undefined ? { stop: op.stop } : {}),
      ...(op.customLists?.length ? { customLists: op.customLists } : {}),
    })
    const shiftDateOut = (s: SeedCell, v: CellValue): CellValue =>
      wb.date1904 && s.date && !s.time && typeof v === 'number' ? v - 1462 : v
    gen.forEach((g, i) => {
      const k = i + 1
      const at =
        dir === 'down'
          ? { row: source.bottom + k, col: line }
          : dir === 'up'
            ? { row: source.top - k, col: line }
            : dir === 'right'
              ? { row: line, col: source.right + k }
              : { row: line, col: source.left - k }
      const s = seed[g.from]!
      const from = pos[g.from]!
      let content: CellContent
      let runs: RichRun[] | undefined
      if (g.kind === 'value') {
        const outVal = shiftDateOut(s, g.value)
        content = outVal === null ? { kind: 'clear' } : { kind: 'value', value: outVal }
      } else if (s.formula !== null) {
        const formula = moveFormula(s.formula, cellName(from), cellName(at))
        content = needsDynamicArray(formula, wb)
          ? { kind: 'formula', formula, dynamicCm: 0 }
          : { kind: 'formula', formula }
      } else {
        const outVal = shiftDateOut(s, s.value)
        content =
          outVal === null || outVal === '' ? { kind: 'clear' } : { kind: 'value', value: outVal }
        if (s.runs && content.kind === 'value') runs = s.runs
      }
      placements.push({ ...at, content, style: s.style, ...(runs ? { runs } : {}) })
    })
  }
  if (placements.length === 0) return { sheets: [] }
  writePlacements(wb, info, placements)
  return { sheets: [info.name] }
}

/** Source and target ranges for Ctrl+D (fill down) / Ctrl+R (fill right). */
export function fillShortcutRange(
  sel: Range,
  dir: 'down' | 'right',
): { source: Range; target: Range } | null {
  if (dir === 'down') {
    if (sel.bottom > sel.top) return { source: { ...sel, bottom: sel.top }, target: sel }
    if (sel.top === 0) return null
    return {
      source: { top: sel.top - 1, bottom: sel.top - 1, left: sel.left, right: sel.right },
      target: { top: sel.top - 1, bottom: sel.bottom, left: sel.left, right: sel.right },
    }
  }
  if (sel.right > sel.left) return { source: { ...sel, right: sel.left }, target: sel }
  if (sel.left === 0) return null
  return {
    source: { top: sel.top, bottom: sel.bottom, left: sel.left - 1, right: sel.left - 1 },
    target: { top: sel.top, bottom: sel.bottom, left: sel.left - 1, right: sel.right },
  }
}

/**
 * Double-clicking the fill handle: the row to fill down to — as far as the
 * column next to the selection (left, else right) has cells in a run from
 * the selection's last row; null when neither has.
 */
export function fillDownTo(data: SheetData, sel: Range): number | null {
  const filled = (r: number, c: number) => {
    const x = data.cells.get(cellKey(r, c))
    return !!x && (x.value !== null || x.formula !== null)
  }
  for (const c of [sel.left - 1, sel.right + 1]) {
    if (c < 0 || !filled(sel.bottom + 1, c)) continue
    let r = sel.bottom + 1
    while (r + 1 <= data.maxRow && filled(r + 1, c)) r++
    return r
  }
  return null
}
