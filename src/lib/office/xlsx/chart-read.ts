import { fillOf, type Theme } from './chart-color'
import { kid, kids, NS_A, NS_CHART, textOf } from './xml'

/**
 * A chart part (DrawingML charts, ECMA-376 Part 1 §21.2: `c:chartSpace`)
 * read into a plain model: its chart groups (bar, line, area, pie,
 * doughnut, scatter, bubble, radar, stock; the 3-D groups drawn as their
 * flat kind), series with their cell references (`c:f`) and the values
 * cached with them, axes, title, legend, data labels and colours. The XML
 * itself stays the source of truth: writers edit it in place (chart-write.ts).
 */

export type ChartKind =
  'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter' | 'bubble' | 'radar' | 'stock'

export const CHART_KINDS: readonly ChartKind[] = [
  'column',
  'bar',
  'line',
  'area',
  'pie',
  'doughnut',
  'scatter',
  'bubble',
  'radar',
  'stock',
]

/** Excel's grouping of series in one chart group (§21.2.2.76/77). */
export type Grouping = 'clustered' | 'stacked' | 'percentStacked' | 'standard'

/** A data source as the file writes it: the reference (null: literal values only) and its cached points. */
export type DataSource = {
  formula: string | null
  kind: 'num' | 'str'
  /** Cached points by index (ptCount long; a missing point is null). */
  cache: Array<number | string | null>
  formatCode: string | null
}

export type LabelOptions = {
  value: boolean
  category: boolean
  series: boolean
  percent: boolean
  /** §21.2.3.12 ST_DLblPos (ctr, inEnd, outEnd, t, b, l, r, bestFit, inBase). */
  position: string | null
}

export type SeriesModel = {
  /** The `c:idx` (unique in the chart; colours follow it). */
  idx: number
  order: number
  name: { formula: string | null; text: string | null }
  /** Category labels (`c:cat`; scatter/bubble: `c:xVal`). */
  cat: DataSource | null
  /** Values (`c:val`; scatter/bubble: `c:yVal`). */
  val: DataSource | null
  /** Bubble sizes (`c:bubbleSize`). */
  size: DataSource | null
  /** The fill (bars, areas, slices, bubbles) or line colour the file sets; null: automatic. */
  color: string | null
  lineColor: string | 'none' | null
  lineWidthPx: number | null
  dash: boolean
  marker: { symbol: string; size: number; color: string | null } | null
  smooth: boolean
  /** Per-point colours (`c:dPt`), by point index. */
  points: Map<number, string>
  labels: LabelOptions | null
}

export type PlotModel = {
  kind: ChartKind
  /** The element's local name (barChart, line3DChart …). */
  element: string
  grouping: Grouping
  varyColors: boolean
  /** Doughnut hole, percent of the radius (10–90). */
  holeSize: number
  firstSliceAngle: number
  gapWidth: number
  overlap: number
  /** Scatter: lines between points ('lineMarker', 'marker', 'smoothMarker', 'line', 'none', 'smooth'). */
  scatterStyle: string | null
  radarStyle: string | null
  axIds: number[]
  series: SeriesModel[]
  labels: LabelOptions | null
  /** Drawn on the secondary axes (its value axis is not the chart's first). */
  secondary: boolean
}

export type AxisModel = {
  id: number
  kind: 'cat' | 'val' | 'date' | 'ser'
  /** Where it sits: b(ottom), l(eft), r(ight), t(op). */
  pos: 'b' | 'l' | 'r' | 't'
  deleted: boolean
  title: string | null
  min: number | null
  max: number | null
  majorUnit: number | null
  logBase: number | null
  reversed: boolean
  numFmt: { code: string; linked: boolean } | null
  majorGridlines: boolean
  minorGridlines: boolean
  crossAx: number
  tickLabels: boolean
  color: string | null
}

export type LegendPos = 'r' | 'l' | 't' | 'b' | 'tr'

export type ChartModel = {
  /** The title text (rich text, or a cell reference's cached text); null when there is none. */
  title: string | null
  titleFormula: string | null
  /** The title element is there without text: Excel shows the series name (one series) or "Chart Title". */
  autoTitle: boolean
  autoTitleDeleted: boolean
  legend: { pos: LegendPos } | null
  plots: PlotModel[]
  axes: AxisModel[]
  /** How empty cells draw (gap, zero, span). */
  blanks: 'gap' | 'zero' | 'span'
  /** Chart area and plot area fills (null: Excel's white / none). */
  background: string | 'none' | null
  plotBackground: string | 'none' | null
  /** Chart groups this editor does not draw (surface, ofPie …), by element name. */
  unsupported: string[]
}

const GROUPS: Record<string, ChartKind | null> = {
  barChart: 'column',
  bar3DChart: 'column',
  lineChart: 'line',
  line3DChart: 'line',
  areaChart: 'area',
  area3DChart: 'area',
  pieChart: 'pie',
  pie3DChart: 'pie',
  doughnutChart: 'doughnut',
  ofPieChart: null,
  scatterChart: 'scatter',
  bubbleChart: 'bubble',
  radarChart: 'radar',
  stockChart: 'stock',
  surfaceChart: null,
  surface3DChart: null,
}

const AXES: Record<string, AxisModel['kind']> = {
  catAx: 'cat',
  valAx: 'val',
  dateAx: 'date',
  serAx: 'ser',
}

/** A chart-namespace child. */
export const ck = (el: Element | null, name: string): Element | null =>
  el ? kid(el, name, NS_CHART) : null
export const cks = (el: Element | null, name?: string): Element[] =>
  el ? kids(el, name, NS_CHART) : []

/** The `val` attribute of child `name` (null when absent). */
export const valOf = (el: Element | null, name: string): string | null =>
  ck(el, name)?.getAttribute('val') ?? null

/** A CT_Boolean: an element without `val` means true (§21.2.2 boolean defaults). */
const boolOf = (el: Element | null, name: string, absent: boolean): boolean => {
  const e = ck(el, name)
  if (!e) return absent
  const v = e.getAttribute('val')
  return v === null || v === '1' || v === 'true'
}

const numVal = (el: Element | null, name: string): number | null => {
  const v = valOf(el, name)
  if (v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function readCache(cache: Element | null, kind: 'num' | 'str'): DataSource['cache'] {
  if (!cache) return []
  const count = numVal(cache, 'ptCount') ?? 0
  const out: DataSource['cache'] = Array.from({ length: count }, () => null)
  for (const pt of cks(cache, 'pt')) {
    const i = Number(pt.getAttribute('idx'))
    if (!Number.isInteger(i) || i < 0) continue
    const v = textOf(ck(pt, 'v'))
    if (i >= out.length) out.length = i + 1
    if (kind === 'num') {
      const n = Number(v)
      out[i] = v !== '' && Number.isFinite(n) ? n : null
    } else out[i] = v
  }
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = null
  return out
}

/** A data source element (c:cat, c:val, c:xVal …): numRef / strRef / numLit / strLit / multiLvlStrRef. */
export function readSource(el: Element | null): DataSource | null {
  if (!el) return null
  const numRef = ck(el, 'numRef')
  if (numRef) {
    const cache = ck(numRef, 'numCache')
    return {
      formula: textOf(ck(numRef, 'f')) || null,
      kind: 'num',
      cache: readCache(cache, 'num'),
      formatCode: textOf(ck(cache, 'formatCode')) || null,
    }
  }
  const strRef = ck(el, 'strRef')
  if (strRef)
    return {
      formula: textOf(ck(strRef, 'f')) || null,
      kind: 'str',
      cache: readCache(ck(strRef, 'strCache'), 'str'),
      formatCode: null,
    }
  const multi = ck(el, 'multiLvlStrRef')
  if (multi) {
    // Several label levels: the first level is the one next to the axis (§21.2.2.102).
    const lvl = cks(ck(multi, 'multiLvlStrCache'), 'lvl')[0] ?? null
    const count = numVal(ck(multi, 'multiLvlStrCache'), 'ptCount') ?? 0
    const cache = readCache(lvl, 'str')
    cache.length = Math.max(cache.length, count)
    for (let i = 0; i < cache.length; i++) cache[i] ??= null
    return { formula: textOf(ck(multi, 'f')) || null, kind: 'str', cache, formatCode: null }
  }
  const numLit = ck(el, 'numLit')
  if (numLit)
    return {
      formula: null,
      kind: 'num',
      cache: readCache(numLit, 'num'),
      formatCode: textOf(ck(numLit, 'formatCode')) || null,
    }
  const strLit = ck(el, 'strLit')
  if (strLit)
    return { formula: null, kind: 'str', cache: readCache(strLit, 'str'), formatCode: null }
  return null
}

/** The plain text of a rich-text body (`c:rich`): its paragraphs' runs, lines joined by "\n". */
export function richText(rich: Element | null): string {
  if (!rich) return ''
  return kids(rich, 'p', NS_A)
    .map((p) =>
      kids(p, undefined, NS_A)
        .map((r) =>
          r.localName === 'r' || r.localName === 'fld'
            ? textOf(kid(r, 't', NS_A))
            : r.localName === 'br'
              ? '\n'
              : '',
        )
        .join(''),
    )
    .join('\n')
}

/** A title (`c:title`, chart or axis): its text, the reference it reads, or neither (automatic). */
function readTitle(title: Element | null): { text: string | null; formula: string | null } {
  const tx = ck(title, 'tx')
  const rich = ck(tx, 'rich')
  if (rich) return { text: richText(rich), formula: null }
  const ref = ck(tx, 'strRef')
  if (ref) {
    const cache = readCache(ck(ref, 'strCache'), 'str')
    return { text: cache.map((v) => v ?? '').join(' '), formula: textOf(ck(ref, 'f')) || null }
  }
  return { text: null, formula: null }
}

function readLabels(d: Element | null): LabelOptions | null {
  if (!d || boolOf(d, 'delete', false)) return null
  const out = {
    value: boolOf(d, 'showVal', false),
    category: boolOf(d, 'showCatName', false),
    series: boolOf(d, 'showSerName', false),
    percent: boolOf(d, 'showPercent', false),
    position: valOf(d, 'dLblPos'),
  }
  return out.value || out.category || out.series || out.percent ? out : null
}

const EMU_PER_PX = 9525

function readSeries(ser: Element, theme: Theme, scatterLike: boolean): SeriesModel {
  const tx = ck(ser, 'tx')
  const strRef = ck(tx, 'strRef')
  const name = strRef
    ? {
        formula: textOf(ck(strRef, 'f')) || null,
        text: readCache(ck(strRef, 'strCache'), 'str')[0]?.toString() ?? null,
      }
    : { formula: null, text: tx ? textOf(ck(tx, 'v')) || null : null }
  const spPr = ck(ser, 'spPr')
  const ln = spPr ? kid(spPr, 'ln', NS_A) : null
  const fill = fillOf(spPr, theme)
  const lineFill = fillOf(ln, theme)
  const w = ln?.getAttribute('w')
  const markerEl = ck(ser, 'marker')
  const symbol = valOf(markerEl, 'symbol')
  const markerFill = fillOf(ck(markerEl, 'spPr'), theme)
  const points = new Map<number, string>()
  for (const dPt of cks(ser, 'dPt')) {
    const i = numVal(dPt, 'idx')
    const c = fillOf(ck(dPt, 'spPr'), theme)
    if (i !== null && c && c !== 'none') points.set(i, c)
  }
  return {
    idx: numVal(ser, 'idx') ?? 0,
    order: numVal(ser, 'order') ?? 0,
    name,
    cat: readSource(ck(ser, scatterLike ? 'xVal' : 'cat')),
    val: readSource(ck(ser, scatterLike ? 'yVal' : 'val')),
    size: readSource(ck(ser, 'bubbleSize')),
    color: fill === 'none' ? null : fill,
    lineColor: lineFill,
    lineWidthPx: w ? Number(w) / EMU_PER_PX : null,
    dash: !!(
      ln &&
      kid(ln, 'prstDash', NS_A) &&
      kid(ln, 'prstDash', NS_A)!.getAttribute('val') !== 'solid'
    ),
    marker:
      markerEl || symbol
        ? {
            symbol: symbol ?? 'auto',
            size: numVal(markerEl, 'size') ?? 5,
            color: markerFill === 'none' ? null : markerFill,
          }
        : null,
    smooth: boolOf(ser, 'smooth', false),
    points,
    labels: readLabels(ck(ser, 'dLbls')),
  }
}

/** Reads a chart part (`c:chartSpace`). */
export function readChart(doc: XMLDocument, theme: Theme): ChartModel {
  const space = doc.documentElement!
  const chart = ck(space, 'chart')
  const plotArea = ck(chart, 'plotArea')
  const unsupported: string[] = []
  const plots: PlotModel[] = []
  const axes: AxisModel[] = []
  for (const el of cks(plotArea)) {
    const name = el.localName!
    if (name in GROUPS) {
      const kind0 = GROUPS[name]
      if (!kind0) {
        unsupported.push(name)
        continue
      }
      const barDir = valOf(el, 'barDir')
      const kind: ChartKind = kind0 === 'column' && barDir === 'bar' ? 'bar' : kind0
      const scatterLike = kind === 'scatter' || kind === 'bubble'
      const grouping = (valOf(el, 'grouping') ??
        (kind === 'line' || kind === 'area' ? 'standard' : 'clustered')) as Grouping
      plots.push({
        kind,
        element: name,
        grouping,
        varyColors: boolOf(el, 'varyColors', false),
        holeSize: numVal(el, 'holeSize') ?? 50,
        firstSliceAngle: numVal(el, 'firstSliceAng') ?? 0,
        gapWidth: numVal(el, 'gapWidth') ?? 150,
        overlap:
          numVal(el, 'overlap') ?? (grouping === 'clustered' || grouping === 'standard' ? 0 : 100),
        scatterStyle: valOf(el, 'scatterStyle'),
        radarStyle: valOf(el, 'radarStyle'),
        axIds: cks(el, 'axId').map((a) => Number(a.getAttribute('val'))),
        series: cks(el, 'ser')
          .map((s) => readSeries(s, theme, scatterLike))
          .sort((a, b) => a.order - b.order),
        labels: readLabels(ck(el, 'dLbls')),
        secondary: false,
      })
    } else if (name in AXES) {
      const scaling = ck(el, 'scaling')
      const numFmt = ck(el, 'numFmt')
      const title = ck(el, 'title')
      const spPr = ck(el, 'spPr')
      const ln = spPr ? kid(spPr, 'ln', NS_A) : null
      const lnFill = fillOf(ln, theme)
      axes.push({
        id: numVal(el, 'axId') ?? 0,
        kind: AXES[name]!,
        pos: (valOf(el, 'axPos') ?? 'b') as AxisModel['pos'],
        deleted: boolOf(el, 'delete', false),
        title: title ? (readTitle(title).text ?? 'Axis Title') : null,
        min: numVal(scaling, 'min'),
        max: numVal(scaling, 'max'),
        majorUnit: numVal(el, 'majorUnit'),
        logBase: numVal(scaling, 'logBase'),
        reversed: valOf(scaling, 'orientation') === 'maxMin',
        numFmt: numFmt
          ? {
              code: numFmt.getAttribute('formatCode') ?? 'General',
              linked: numFmt.getAttribute('sourceLinked') === '1',
            }
          : null,
        majorGridlines: !!ck(el, 'majorGridlines'),
        minorGridlines: !!ck(el, 'minorGridlines'),
        crossAx: numVal(el, 'crossAx') ?? 0,
        tickLabels: valOf(el, 'tickLblPos') !== 'none',
        color: lnFill === 'none' ? null : lnFill,
      })
    }
  }
  // The secondary chart groups: those whose value axis is not the first group's.
  const valAxisOf = (p: PlotModel) =>
    p.axIds.find((id) => axes.find((a) => a.id === id)?.kind === 'val') ?? null
  const primary = plots.find((p) => p.axIds.length > 0)
  const primaryVal = primary ? valAxisOf(primary) : null
  for (const p of plots)
    p.secondary = p.axIds.length > 0 && primaryVal !== null && valAxisOf(p) !== primaryVal
  const titleEl = ck(chart, 'title')
  const t = readTitle(titleEl)
  const legendEl = ck(chart, 'legend')
  const blanks = valOf(chart, 'dispBlanksAs')
  return {
    title: t.text,
    titleFormula: t.formula,
    autoTitle: !!titleEl && t.text === null,
    autoTitleDeleted: boolOf(chart, 'autoTitleDeleted', false),
    legend: legendEl ? { pos: (valOf(legendEl, 'legendPos') ?? 'r') as LegendPos } : null,
    plots,
    axes,
    blanks: blanks === 'zero' || blanks === 'span' ? blanks : 'gap',
    background: fillOf(ck(space, 'spPr'), theme),
    plotBackground: fillOf(ck(plotArea, 'spPr'), theme),
    unsupported,
  }
}
