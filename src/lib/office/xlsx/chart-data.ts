import type { Calc } from './calc'
import type { ChartModel, DataSource, PlotModel, SeriesModel } from './chart-read'
import { parseA1Ref, tokenize } from '@borgar/fx/xlsx'
import { autoColor, type Theme } from './chart-color'
import { displayValue, formatCode, type SheetLocale } from './format'
import { cellKey, type Range } from './ref'
import { isErrorValue, type CellValue, type Workbook } from './workbook'

/**
 * A chart's series read live from the cells their references (`c:f`) name,
 * so a chart follows every edit. When a reference can't be resolved here (a
 * name that is not a plain range, another workbook, a sheet that is gone) the
 * values cached in the chart part are used and the series is marked
 * `cached` — never guessed. Excel's "show data in hidden rows and columns"
 * (`plotVisOnly`, on by default) is honoured: hidden cells are left out.
 */

export type CellsRef = { sheet: string; ranges: Range[] }

type Ref = { sheetName?: string; workbookName?: string; range?: Range; name?: string }

/** The cells a chart reference names: `Sheet1!$B$2:$B$5`, a union `(…,…)`, or a defined name of one; null when it can't be resolved. */
export function resolveRef(wb: Workbook, formula: string, depth = 0): CellsRef | null {
  if (depth > 3) return null
  let toks: Array<{ type: string; value: string }>
  try {
    toks = tokenize(formula, { mergeRefs: true }) as typeof toks
  } catch {
    return null
  }
  const refs = toks.filter((t) => t.type !== 'operator' && t.type !== 'whitespace')
  if (toks.some((t) => t.type === 'operator' && !['(', ')', ','].includes(t.value))) return null
  let sheet: string | null = null
  const ranges: Range[] = []
  for (const t of refs) {
    if (t.type !== 'range' && t.type !== 'range_named') return null
    const r = parseA1Ref(t.value) as Ref | undefined
    if (!r || r.workbookName) return null
    if (r.name) {
      const def = wb
        .definedNames()
        .find((n) => n.localSheet === null && n.name.toLowerCase() === r.name!.toLowerCase())
      const inner = def ? resolveRef(wb, def.formula, depth + 1) : null
      if (!inner || (sheet !== null && inner.sheet.toLowerCase() !== sheet.toLowerCase()))
        return null
      sheet = inner.sheet
      ranges.push(...inner.ranges)
      continue
    }
    if (!r.range || !r.sheetName) return null
    const s = wb.findSheet(r.sheetName)
    if (!s || s.kind !== 'worksheet') return null
    if (sheet !== null && s.name.toLowerCase() !== sheet.toLowerCase()) return null
    sheet = s.name
    const { top, left, bottom, right } = r.range
    if ([top, left, bottom, right].some((v) => v === null || v === undefined)) return null
    ranges.push({ top, left, bottom, right })
  }
  return sheet !== null && ranges.length > 0 ? { sheet, ranges } : null
}

/** The cells of a reference in order (each range row by row), with whether Excel would hide them. */
function cellsOf(
  wb: Workbook,
  ref: CellsRef,
): Array<{ row: number; col: number; hidden: boolean }> {
  const data = wb.sheet(ref.sheet)
  const colHidden = (c: number) => data.cols.some((x) => c >= x.min && c <= x.max && x.hidden)
  const out: Array<{ row: number; col: number; hidden: boolean }> = []
  for (const r of ref.ranges)
    for (let row = r.top; row <= r.bottom; row++)
      for (let col = r.left; col <= r.right; col++)
        out.push({ row, col, hidden: !!data.rows.get(row)?.hidden || colHidden(col) })
  return out
}

export type SeriesData = {
  idx: number
  name: string
  color: string
  /** Point colours (pie slices with varied colours, `c:dPt` overrides). */
  pointColors: string[]
  categories: string[]
  values: Array<number | null>
  /** Scatter / bubble: the numeric x values (null: plotted 1, 2, 3 …). */
  x: Array<number | null> | null
  sizes: Array<number | null> | null
  /** Some of this series came from the chart's cached values: its references can't be read here. */
  cached: boolean
  formatCode: string | null
}

type Point = { value: CellValue; text: string; hidden: boolean }

type Source = { points: Point[]; cached: boolean; live: boolean }

function readLive(
  wb: Workbook,
  calc: Pick<Calc, 'cell'>,
  src: DataSource | null,
  locale: SheetLocale,
): Source | null {
  if (!src) return null
  if (src.formula) {
    const ref = resolveRef(wb, src.formula)
    if (ref) {
      const styles = wb.styles()
      const data = wb.sheet(ref.sheet)
      const points = cellsOf(wb, ref).map(({ row, col, hidden }) => {
        const value = calc.cell(ref.sheet, row, col).value
        const st = styles.xf(data.cells.get(cellKey(row, col))?.style ?? 0)
        const text =
          value === null
            ? ''
            : displayValue(value, formatCode(st.numFmtId, st.numFmt, locale), locale, {
                date1904: wb.date1904,
              }).text
        return { value, text, hidden }
      })
      return { points, cached: false, live: true }
    }
  }
  // A literal, or a reference this can't read: the cached points (a literal is the data itself).
  return {
    points: src.cache.map((v) => ({ value: v, text: v === null ? '' : String(v), hidden: false })),
    cached: src.formula !== null,
    live: false,
  }
}

/** A value point as a number: numbers plot, text plots as 0 (as Excel), empty cells and errors are gaps. */
function plotNumber(v: CellValue, blanks: ChartModel['blanks']): number | null {
  if (typeof v === 'number') return v
  if (v === null) return blanks === 'zero' ? 0 : null
  if (isErrorValue(v)) return null
  if (typeof v === 'boolean') return 0
  return 0
}

/** One chart group's series with their data now. */
export function plotData(
  wb: Workbook,
  calc: Pick<Calc, 'cell'>,
  chart: ChartModel,
  plot: PlotModel,
  theme: Theme,
  locale: SheetLocale,
  visibleOnly = true,
): SeriesData[] {
  return plot.series.map((s) => seriesData(wb, calc, chart, plot, s, theme, locale, visibleOnly))
}

function seriesData(
  wb: Workbook,
  calc: Pick<Calc, 'cell'>,
  chart: ChartModel,
  plot: PlotModel,
  s: SeriesModel,
  theme: Theme,
  locale: SheetLocale,
  visibleOnly: boolean,
): SeriesData {
  const val = readLive(wb, calc, s.val, locale)
  const cat = readLive(wb, calc, s.cat, locale)
  const size = readLive(wb, calc, s.size, locale)
  // Hidden rows/columns of the value cells drop that point everywhere.
  const keep = (val?.points ?? []).map((p) => !(visibleOnly && p.hidden))
  const pick = <T>(xs: T[]) => xs.filter((_, i) => keep[i] ?? true)
  const values = pick((val?.points ?? []).map((p) => plotNumber(p.value, chart.blanks)))
  const n = values.length
  const scatterLike = plot.kind === 'scatter' || plot.kind === 'bubble'
  const catPoints = cat ? pick(cat.points) : []
  const categories = Array.from({ length: n }, (_, i) => catPoints[i]?.text ?? String(i + 1))
  let x: Array<number | null> | null = null
  if (scatterLike) {
    // Scatter x values that are not all numbers are plotted 1, 2, 3 … (as Excel does).
    const nums = catPoints.map((p) => (typeof p.value === 'number' ? p.value : null))
    x = cat && catPoints.length > 0 && nums.every((v) => v !== null) ? nums : null
  }
  let name = s.name.text ?? ''
  let nameCached = false
  if (s.name.formula) {
    const ref = resolveRef(wb, s.name.formula)
    if (ref) {
      name = cellsOf(wb, ref)
        .map(({ row, col }) => {
          const v = calc.cell(ref.sheet, row, col).value
          return v === null ? '' : isErrorValue(v) ? v.error : String(v)
        })
        .filter(Boolean)
        .join(' ')
    } else nameCached = true
  }
  if (!name) name = `Series${s.idx + 1}`
  const color =
    s.color ??
    (s.lineColor && s.lineColor !== 'none' ? s.lineColor : null) ??
    autoColor(s.idx, theme)
  const pointColors = Array.from(
    { length: n },
    (_, i) => s.points.get(i) ?? (plot.varyColors ? autoColor(i, theme) : color),
  )
  return {
    idx: s.idx,
    name,
    color,
    pointColors,
    categories,
    values,
    x,
    sizes: size ? pick(size.points).map((p) => plotNumber(p.value, 'gap')) : null,
    cached: !!(val?.cached || cat?.cached || size?.cached || nameCached),
    formatCode: s.val?.formatCode ?? null,
  }
}

/**
 * The numbers to write as a series' cache when saving a chart (`c:numCache`):
 * the values now, without dropping hidden cells (the cache mirrors the range).
 */
export function cacheOf(
  wb: Workbook,
  calc: Pick<Calc, 'cell'>,
  formula: string,
  kind: 'num' | 'str',
  locale: SheetLocale = 'en',
): Array<number | string | null> | null {
  const ref = resolveRef(wb, formula)
  if (!ref) return null
  const src = readLive(wb, calc, { formula, kind, cache: [], formatCode: null }, locale)
  if (!src) return null
  return src.points.map((p) =>
    kind === 'num'
      ? typeof p.value === 'number'
        ? p.value
        : null
      : p.value === null
        ? null
        : p.text,
  )
}
