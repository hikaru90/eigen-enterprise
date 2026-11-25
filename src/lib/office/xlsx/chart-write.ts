import { DOMParser } from '@xmldom/xmldom'
import { ck, cks, type ChartKind, type Grouping, type LegendPos } from './chart-read'
import { XlsxError } from './workbook'
import { insertInOrder, kid, kids, NS_A, NS_CHART, NS_R } from './xml'

/**
 * Writing DrawingML charts (ECMA-376 Part 1 §21.2): a new chart part from a
 * definition, and edits to an existing one in place — title, legend, axis
 * titles/scale/format/gridlines, data labels, colours, and (when the type or
 * the series change) the chart groups and axes rebuilt, carrying each
 * series' own formatting (by `c:idx`) and each axis' title, scale and number
 * format over. Elements are written in the schema's sequence (the tables
 * below), so Excel opens what this writes; everything else in the part stays.
 */

export const CHART_NS = `xmlns:c="${NS_CHART}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"`

/** A series as the editor defines it: references in A1 form with the sheet ("Sheet1!$B$2:$B$9"). */
export type SeriesDef = {
  /** The values (y values for scatter/bubble). */
  values: string
  /** Category labels (x values for scatter/bubble); null: 1, 2, 3 … */
  categories?: string | null
  /** The series name: a cell reference, or a literal text. */
  name?: { ref: string } | { text: string } | null
  /** Bubble sizes. */
  sizes?: string | null
  /** Combo charts: this series' own type (default: the chart's). */
  type?: ChartKind
  /** Drawn against a second value axis on the right. */
  secondary?: boolean
}

/** A filled series: its references plus the values to cache with them. */
export type FilledSeries = SeriesDef & {
  idx: number
  valCache: Array<number | null>
  catCache: Array<number | string | null> | null
  catNumeric: boolean
  nameCache: string | null
  sizeCache: Array<number | null> | null
}

/** The schema sequences (§21.2.2) of the elements this writer adds children to. */
export const CHART_ORDER: Record<string, readonly string[]> = {
  chartSpace: [
    'date1904',
    'lang',
    'roundedCorners',
    'AlternateContent',
    'style',
    'clrMapOvr',
    'pivotSource',
    'protection',
    'chart',
    'spPr',
    'txPr',
    'externalData',
    'printSettings',
    'userShapes',
    'extLst',
  ],
  chart: [
    'title',
    'autoTitleDeleted',
    'pivotFmts',
    'view3D',
    'floor',
    'sideWall',
    'backWall',
    'plotArea',
    'legend',
    'plotVisOnly',
    'dispBlanksAs',
    'showDLblsOverMax',
    'extLst',
  ],
  title: ['tx', 'layout', 'overlay', 'spPr', 'txPr', 'extLst'],
  legend: ['legendPos', 'legendEntry', 'layout', 'overlay', 'spPr', 'txPr', 'extLst'],
  /** CT_PlotArea: the chart groups are one choice (any order, the primary first), the axes another. */
  plotArea: ['layout', 'GROUP', 'AXIS', 'dTable', 'spPr', 'extLst'],
  catAx: [
    'axId',
    'scaling',
    'delete',
    'axPos',
    'majorGridlines',
    'minorGridlines',
    'title',
    'numFmt',
    'majorTickMark',
    'minorTickMark',
    'tickLblPos',
    'spPr',
    'txPr',
    'crossAx',
    'crosses',
    'crossesAt',
    'auto',
    'lblAlgn',
    'lblOffset',
    'tickLblSkip',
    'tickMarkSkip',
    'noMultiLvlLbl',
    'extLst',
  ],
  dateAx: [
    'axId',
    'scaling',
    'delete',
    'axPos',
    'majorGridlines',
    'minorGridlines',
    'title',
    'numFmt',
    'majorTickMark',
    'minorTickMark',
    'tickLblPos',
    'spPr',
    'txPr',
    'crossAx',
    'crosses',
    'crossesAt',
    'auto',
    'lblOffset',
    'baseTimeUnit',
    'majorUnit',
    'majorTimeUnit',
    'minorUnit',
    'minorTimeUnit',
    'extLst',
  ],
  valAx: [
    'axId',
    'scaling',
    'delete',
    'axPos',
    'majorGridlines',
    'minorGridlines',
    'title',
    'numFmt',
    'majorTickMark',
    'minorTickMark',
    'tickLblPos',
    'spPr',
    'txPr',
    'crossAx',
    'crosses',
    'crossesAt',
    'crossBetween',
    'majorUnit',
    'minorUnit',
    'dispUnits',
    'extLst',
  ],
  scaling: ['logBase', 'orientation', 'max', 'min', 'extLst'],
  dLbls: [
    'dLbl',
    'delete',
    'numFmt',
    'spPr',
    'txPr',
    'dLblPos',
    'showLegendKey',
    'showVal',
    'showCatName',
    'showSerName',
    'showPercent',
    'showBubbleSize',
    'separator',
    'showLeaderLines',
    'leaderLines',
    'extLst',
  ],
  barChart: [
    'barDir',
    'grouping',
    'varyColors',
    'ser',
    'dLbls',
    'gapWidth',
    'overlap',
    'serLines',
    'axId',
    'extLst',
  ],
  bar3DChart: [
    'barDir',
    'grouping',
    'varyColors',
    'ser',
    'dLbls',
    'gapWidth',
    'gapDepth',
    'shape',
    'axId',
    'extLst',
  ],
  lineChart: [
    'grouping',
    'varyColors',
    'ser',
    'dLbls',
    'dropLines',
    'hiLowLines',
    'upDownBars',
    'marker',
    'smooth',
    'axId',
    'extLst',
  ],
  line3DChart: [
    'grouping',
    'varyColors',
    'ser',
    'dLbls',
    'dropLines',
    'gapDepth',
    'axId',
    'extLst',
  ],
  areaChart: ['grouping', 'varyColors', 'ser', 'dLbls', 'dropLines', 'axId', 'extLst'],
  area3DChart: [
    'grouping',
    'varyColors',
    'ser',
    'dLbls',
    'dropLines',
    'gapDepth',
    'axId',
    'extLst',
  ],
  pieChart: ['varyColors', 'ser', 'dLbls', 'firstSliceAng', 'extLst'],
  pie3DChart: ['varyColors', 'ser', 'dLbls', 'extLst'],
  doughnutChart: ['varyColors', 'ser', 'dLbls', 'firstSliceAng', 'holeSize', 'extLst'],
  scatterChart: ['scatterStyle', 'varyColors', 'ser', 'dLbls', 'axId', 'extLst'],
  bubbleChart: [
    'varyColors',
    'ser',
    'dLbls',
    'bubble3D',
    'bubbleScale',
    'showNegBubbles',
    'sizeRepresents',
    'axId',
    'extLst',
  ],
  radarChart: ['radarStyle', 'varyColors', 'ser', 'dLbls', 'axId', 'extLst'],
  stockChart: ['ser', 'dLbls', 'dropLines', 'hiLowLines', 'upDownBars', 'axId', 'extLst'],
}

/** The sequences of each group's `c:ser` (CT_BarSer, CT_LineSer …). */
export const SER_ORDER: Record<string, readonly string[]> = {
  bar: [
    'idx',
    'order',
    'tx',
    'spPr',
    'invertIfNegative',
    'pictureOptions',
    'dPt',
    'dLbls',
    'trendline',
    'errBars',
    'cat',
    'val',
    'shape',
    'extLst',
  ],
  line: [
    'idx',
    'order',
    'tx',
    'spPr',
    'marker',
    'dPt',
    'dLbls',
    'trendline',
    'errBars',
    'cat',
    'val',
    'smooth',
    'extLst',
  ],
  area: [
    'idx',
    'order',
    'tx',
    'spPr',
    'pictureOptions',
    'dPt',
    'dLbls',
    'trendline',
    'errBars',
    'cat',
    'val',
    'extLst',
  ],
  pie: ['idx', 'order', 'tx', 'spPr', 'explosion', 'dPt', 'dLbls', 'cat', 'val', 'extLst'],
  scatter: [
    'idx',
    'order',
    'tx',
    'spPr',
    'marker',
    'dPt',
    'dLbls',
    'trendline',
    'errBars',
    'xVal',
    'yVal',
    'smooth',
    'extLst',
  ],
  bubble: [
    'idx',
    'order',
    'tx',
    'spPr',
    'invertIfNegative',
    'dPt',
    'dLbls',
    'trendline',
    'errBars',
    'xVal',
    'yVal',
    'bubbleSize',
    'bubble3D',
    'extLst',
  ],
  radar: ['idx', 'order', 'tx', 'spPr', 'marker', 'dPt', 'dLbls', 'cat', 'val', 'extLst'],
}

const SER_KIND: Record<string, keyof typeof SER_ORDER> = {
  barChart: 'bar',
  bar3DChart: 'bar',
  lineChart: 'line',
  line3DChart: 'line',
  stockChart: 'line',
  areaChart: 'area',
  area3DChart: 'area',
  pieChart: 'pie',
  pie3DChart: 'pie',
  doughnutChart: 'pie',
  ofPieChart: 'pie',
  scatterChart: 'scatter',
  bubbleChart: 'bubble',
  radarChart: 'radar',
}

export const serOrderOf = (groupElement: string) => SER_ORDER[SER_KIND[groupElement] ?? 'bar']!

export const GROUP_ELEMENTS = new Set([...Object.keys(SER_KIND), 'surfaceChart', 'surface3DChart'])
export const AXIS_ELEMENTS = new Set(['valAx', 'catAx', 'dateAx', 'serAx'])

/** A plot area child's place in CT_PlotArea's sequence (chart groups and axes are choices). */
export const plotAreaRank = (name: string) =>
  GROUP_ELEMENTS.has(name) ? 'GROUP' : AXIS_ELEMENTS.has(name) ? 'AXIS' : name

/** Appends a chart group or axis to the plot area after the others of its kind (before dTable, spPr …). */
export function insertInPlotArea(plotArea: Element, el: Element) {
  const order = CHART_ORDER.plotArea!
  const at = order.indexOf(plotAreaRank(el.localName!))
  const next = kids(plotArea, undefined).find((k) => order.indexOf(plotAreaRank(k.localName!)) > at)
  plotArea.insertBefore(el, next ?? null)
}

const GROUP_ELEMENT: Record<ChartKind, string> = {
  column: 'barChart',
  bar: 'barChart',
  line: 'lineChart',
  area: 'areaChart',
  pie: 'pieChart',
  doughnut: 'doughnutChart',
  scatter: 'scatterChart',
  bubble: 'bubbleChart',
  radar: 'radarChart',
  stock: 'stockChart',
}

export const hasAxes = (k: ChartKind) => k !== 'pie' && k !== 'doughnut'
const scatterLike = (k: ChartKind) => k === 'scatter' || k === 'bubble'

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const v = (name: string, val: string | number) => `<c:${name} val="${esc(String(val))}"/>`

function numCache(points: Array<number | null>, code = 'General') {
  return `<c:numCache><c:formatCode>${esc(code)}</c:formatCode><c:ptCount val="${points.length}"/>${points
    .map((p, i) => (p === null ? '' : `<c:pt idx="${i}"><c:v>${p}</c:v></c:pt>`))
    .join('')}</c:numCache>`
}

function strCache(points: Array<number | string | null>) {
  return `<c:strCache><c:ptCount val="${points.length}"/>${points
    .map((p, i) => (p === null ? '' : `<c:pt idx="${i}"><c:v>${esc(String(p))}</c:v></c:pt>`))
    .join('')}</c:strCache>`
}

const numRef = (f: string, cache: Array<number | null>) =>
  `<c:numRef><c:f>${esc(f)}</c:f>${numCache(cache)}</c:numRef>`
const strRef = (f: string, cache: Array<number | string | null>) =>
  `<c:strRef><c:f>${esc(f)}</c:f>${strCache(cache)}</c:strRef>`

/** A rich-text body with one paragraph per line (titles). */
export function richXml(text: string, vertical = false): string {
  const paras = text
    .split('\n')
    .map(
      (line) =>
        `<a:p><a:pPr><a:defRPr/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${esc(line)}</a:t></a:r></a:p>`,
    )
    .join('')
  return `<c:rich><a:bodyPr${vertical ? ' rot="-5400000" vert="horz"' : ''}/><a:lstStyle/>${paras}</c:rich>`
}

const titleXml = (text: string, vertical = false) =>
  `<c:title><c:tx>${richXml(text, vertical)}</c:tx><c:overlay val="0"/></c:title>`

/** The scheme accent Excel gives series `i` (style 2): accent1–6, then darker/lighter. */
function accentXml(i: number): string {
  const n = (i % 6) + 1
  const cycle = Math.floor(i / 6) % 4
  const mods = [
    '',
    '<a:lumMod val="60000"/>',
    '<a:lumMod val="80000"/><a:lumOff val="20000"/>',
    '<a:lumMod val="80000"/>',
  ][cycle]
  return `<a:schemeClr val="accent${n}">${mods}</a:schemeClr>`
}

/** Explicit colour XML from `#RRGGBB`. */
export const rgbXml = (hex: string) => `<a:srgbClr val="${hex.replace('#', '').toUpperCase()}"/>`

function serSpPr(kind: ChartKind, i: number, color?: string): string {
  const clr = color ? rgbXml(color) : accentXml(i)
  if (kind === 'line' || kind === 'scatter' || kind === 'radar')
    return `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill>${clr}</a:solidFill><a:round/></a:ln></c:spPr>`
  if (kind === 'stock') return `<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr>`
  if (kind === 'pie' || kind === 'doughnut') return ''
  return `<c:spPr><a:solidFill>${clr}</a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>`
}

/** One `c:ser` for a group of `kind`. */
export function serXml(kind: ChartKind, s: FilledSeries, order: number): string {
  const tx =
    s.name && 'ref' in s.name
      ? `<c:tx>${strRef(s.name.ref, [s.nameCache])}</c:tx>`
      : s.name && 'text' in s.name
        ? `<c:tx><c:v>${esc(s.name.text)}</c:v></c:tx>`
        : ''
  const cat = s.categories
    ? s.catNumeric
      ? numRef(
          s.categories,
          (s.catCache ?? []).map((x) => (typeof x === 'number' ? x : null)),
        )
      : strRef(s.categories, s.catCache ?? [])
    : ''
  const val = numRef(s.values, s.valCache)
  const head = `${v('idx', s.idx)}${v('order', order)}${tx}${serSpPr(kind, s.idx)}`
  switch (kind) {
    case 'column':
    case 'bar':
      return `<c:ser>${head}${v('invertIfNegative', 0)}${cat ? `<c:cat>${cat}</c:cat>` : ''}<c:val>${val}</c:val></c:ser>`
    case 'line':
    case 'stock':
      return `<c:ser>${head}<c:marker>${v('symbol', 'none')}</c:marker>${cat ? `<c:cat>${cat}</c:cat>` : ''}<c:val>${val}</c:val>${v('smooth', 0)}</c:ser>`
    case 'radar':
      return `<c:ser>${head}<c:marker>${v('symbol', 'none')}</c:marker>${cat ? `<c:cat>${cat}</c:cat>` : ''}<c:val>${val}</c:val></c:ser>`
    case 'area':
    case 'pie':
    case 'doughnut':
      return `<c:ser>${head}${cat ? `<c:cat>${cat}</c:cat>` : ''}<c:val>${val}</c:val></c:ser>`
    case 'scatter':
      return `<c:ser>${head}<c:marker>${v('symbol', 'circle')}${v('size', 5)}</c:marker>${cat ? `<c:xVal>${cat}</c:xVal>` : ''}<c:yVal>${val}</c:yVal>${v('smooth', 0)}</c:ser>`
    case 'bubble': {
      const size = s.sizes
        ? `<c:bubbleSize>${numRef(s.sizes, s.sizeCache ?? [])}</c:bubbleSize>`
        : `<c:bubbleSize>${numRef(s.values, s.valCache)}</c:bubbleSize>`
      return `<c:ser>${head}${v('invertIfNegative', 0)}${cat ? `<c:xVal>${cat}</c:xVal>` : ''}<c:yVal>${val}</c:yVal>${size}${v('bubble3D', 0)}</c:ser>`
    }
  }
}

/** A chart group element with its series and axis ids. */
export function groupXml(
  kind: ChartKind,
  grouping: Grouping | undefined,
  series: FilledSeries[],
  axIds: [number, number] | null,
  startOrder: number,
): string {
  const el = GROUP_ELEMENT[kind]
  const sers = series.map((s, i) => serXml(kind, s, startOrder + i)).join('')
  const ax = axIds ? `<c:axId val="${axIds[0]}"/><c:axId val="${axIds[1]}"/>` : ''
  const g = grouping ?? 'clustered'
  switch (kind) {
    case 'column':
    case 'bar': {
      const gr = g === 'standard' ? 'clustered' : g
      return `<c:${el}>${v('barDir', kind === 'bar' ? 'bar' : 'col')}${v('grouping', gr)}${v('varyColors', 0)}${sers}${v('gapWidth', gr === 'clustered' ? 219 : 150)}${gr === 'clustered' ? v('overlap', -27) : v('overlap', 100)}${ax}</c:${el}>`
    }
    case 'line':
    case 'area': {
      const gr = g === 'clustered' ? 'standard' : g
      return `<c:${el}>${v('grouping', gr)}${v('varyColors', 0)}${sers}${kind === 'line' ? v('marker', 1) : ''}${ax}</c:${el}>`
    }
    case 'pie':
      return `<c:${el}>${v('varyColors', 1)}${sers}${v('firstSliceAng', 0)}</c:${el}>`
    case 'doughnut':
      return `<c:${el}>${v('varyColors', 1)}${sers}${v('firstSliceAng', 0)}${v('holeSize', 75)}</c:${el}>`
    case 'scatter':
      return `<c:${el}>${v('scatterStyle', 'lineMarker')}${v('varyColors', 0)}${sers}${ax}</c:${el}>`
    case 'bubble':
      return `<c:${el}>${v('varyColors', 0)}${sers}${v('bubbleScale', 100)}${v('showNegBubbles', 0)}${ax}</c:${el}>`
    case 'radar':
      return `<c:${el}>${v('radarStyle', 'marker')}${v('varyColors', 0)}${sers}${ax}</c:${el}>`
    case 'stock':
      return `<c:${el}>${sers}<c:hiLowLines/>${ax}</c:${el}>`
  }
}

/** An axis pair (category or x, value or y) for one side. */
export function axesXml(kind: ChartKind, ids: [number, number], secondary: boolean): string {
  const horizontal = kind === 'bar'
  const catPos = secondary ? (horizontal ? 'r' : 't') : horizontal ? 'l' : 'b'
  const valPos = secondary ? (horizontal ? 't' : 'r') : horizontal ? 'b' : 'l'
  const grid = secondary ? '' : '<c:majorGridlines/>'
  const common = (pos: string, deleted: boolean) =>
    `<c:scaling>${v('orientation', 'minMax')}</c:scaling>${v('delete', deleted ? 1 : 0)}${v('axPos', pos)}`
  const ticks = `${v('majorTickMark', 'none')}${v('minorTickMark', 'none')}${v('tickLblPos', 'nextTo')}`
  if (scatterLike(kind))
    return (
      `<c:valAx>${v('axId', ids[0])}${common(secondary ? 't' : 'b', secondary)}<c:numFmt formatCode="General" sourceLinked="1"/>${ticks}${v('crossAx', ids[1])}${v('crosses', secondary ? 'max' : 'autoZero')}${v('crossBetween', 'midCat')}</c:valAx>` +
      `<c:valAx>${v('axId', ids[1])}${common(valPos, false)}${grid}<c:numFmt formatCode="General" sourceLinked="1"/>${ticks}${v('crossAx', ids[0])}${v('crosses', secondary ? 'max' : 'autoZero')}${v('crossBetween', 'midCat')}</c:valAx>`
    )
  return (
    `<c:catAx>${v('axId', ids[0])}${common(catPos, secondary)}<c:numFmt formatCode="General" sourceLinked="1"/>${ticks}${v('crossAx', ids[1])}${v('crosses', 'autoZero')}${v('auto', 1)}${v('lblAlgn', 'ctr')}${v('lblOffset', 100)}${v('noMultiLvlLbl', 0)}</c:catAx>` +
    `<c:valAx>${v('axId', ids[1])}${common(valPos, false)}${grid}<c:numFmt formatCode="General" sourceLinked="1"/>${ticks}${v('crossAx', ids[0])}${v('crosses', secondary ? 'max' : 'autoZero')}${v('crossBetween', kind === 'area' ? 'midCat' : 'between')}</c:valAx>`
  )
}

/** Axis ids Excel-style (large, unique within the part). */
export const AXIS_IDS = {
  primary: [500000001, 500000002] as [number, number],
  secondary: [500000003, 500000004] as [number, number],
}

/** The groups a set of series makes: one per (type, side), in the order they first appear. */
export function groupsOf(
  kind: ChartKind,
  series: FilledSeries[],
): Array<{ kind: ChartKind; secondary: boolean; series: FilledSeries[] }> {
  const out: Array<{ kind: ChartKind; secondary: boolean; series: FilledSeries[] }> = []
  for (const s of series) {
    const k = s.type ?? kind
    // A pie or doughnut can't share a chart with axes; Excel puts a combo's pies on their own.
    const sec = !!s.secondary && hasAxes(k)
    let g = out.find((x) => x.kind === k && x.secondary === sec)
    if (!g) out.push((g = { kind: k, secondary: sec, series: [] }))
    g.series.push(s)
  }
  if (out.some((g) => !hasAxes(g.kind)) && out.length > 1)
    throw new XlsxError('A pie or doughnut chart can’t be combined with other chart types.')
  if (out.some((g) => scatterLike(g.kind)) && out.some((g) => !scatterLike(g.kind)))
    throw new XlsxError(
      'A scatter or bubble chart can’t be combined with column, line or area series.',
    )
  if (out.some((g) => g.kind === 'bar') && out.some((g) => g.kind !== 'bar'))
    throw new XlsxError('Horizontal bars can’t be combined with other chart types (use columns).')
  if (out.every((g) => g.secondary)) for (const g of out) g.secondary = false
  // The primary group first: Excel reads the first group with axes as the primary one.
  return [...out.filter((g) => !g.secondary), ...out.filter((g) => g.secondary)]
}

/** The plot area's groups and axes for these series. */
export function plotAreaInner(
  kind: ChartKind,
  grouping: Grouping | undefined,
  series: FilledSeries[],
): string {
  const groups = groupsOf(kind, series)
  let order = 0
  const parts: string[] = []
  let primaryKind: ChartKind | null = null
  let secondaryKind: ChartKind | null = null
  for (const g of groups) {
    const ids = !hasAxes(g.kind) ? null : g.secondary ? AXIS_IDS.secondary : AXIS_IDS.primary
    parts.push(groupXml(g.kind, g.kind === kind ? grouping : undefined, g.series, ids, order))
    order += g.series.length
    if (ids && !g.secondary) primaryKind ??= g.kind
    if (ids && g.secondary) secondaryKind ??= g.kind
  }
  const axes =
    (primaryKind ? axesXml(primaryKind, AXIS_IDS.primary, false) : '') +
    (secondaryKind ? axesXml(secondaryKind, AXIS_IDS.secondary, true) : '')
  return parts.join('') + axes
}

export type NewChart = {
  type: ChartKind
  grouping?: Grouping
  series: FilledSeries[]
  title: string | null
  legend: LegendPos | null
}

/** A complete new chart part. */
export function newChartXml(c: NewChart): string {
  const title = c.title
    ? `${titleXml(c.title)}${v('autoTitleDeleted', 0)}`
    : v('autoTitleDeleted', 1)
  const legend = c.legend
    ? `<c:legend>${v('legendPos', c.legend)}<c:overlay val="0"/></c:legend>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace ${CHART_NS}>${v('date1904', 0)}${v('lang', 'en-US')}${v('roundedCorners', 0)}<c:chart>${title}<c:plotArea><c:layout/>${plotAreaInner(c.type, c.grouping, c.series)}</c:plotArea>${legend}${v('plotVisOnly', 1)}${v('dispBlanksAs', 'gap')}</c:chart><c:spPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill><a:round/></a:ln></c:spPr></c:chartSpace>`
}

// ---------------------------------------------------------------------------
// Editing in place

const parseFragment = (xml: string): Element => {
  const doc = new DOMParser().parseFromString(
    `<root ${CHART_NS}>${xml}</root>`,
    'application/xml',
  ) as unknown as XMLDocument
  return doc.documentElement!
}

/** Parses chart-namespace XML into nodes owned by `doc`. */
export function fragment(doc: XMLDocument, xml: string): Element[] {
  return kids(parseFragment(xml), undefined, NS_CHART).map(
    (e) => doc.importNode(e, true) as Element,
  )
}

function cel(doc: XMLDocument, name: string): Element {
  const root = doc.documentElement!
  const prefix =
    root.lookupPrefix(NS_CHART) ?? (root.namespaceURI === NS_CHART ? root.prefix : null)
  return doc.createElementNS(NS_CHART, prefix ? `${prefix}:${name}` : name)
}

/** Sets `<c:name val>` under `parent` (created in schema order when missing). */
export function setVal(parent: Element, name: string, val: string, order: readonly string[]) {
  let el = ck(parent, name)
  if (!el) {
    el = cel(parent.ownerDocument!, name)
    insertInOrder(parent, el, order)
  }
  el.setAttribute('val', val)
}

export function removeChild(parent: Element | null, name: string) {
  for (const el of cks(parent, name)) parent!.removeChild(el)
}

/** Replaces (or removes, when `xml` is null) the child `name` of `parent`, in schema order. */
export function replaceChild(
  parent: Element,
  name: string,
  xml: string | null,
  order: readonly string[],
) {
  const doc = parent.ownerDocument!
  const old = ck(parent, name)
  if (xml === null) {
    if (old) parent.removeChild(old)
    return
  }
  const [next] = fragment(doc, xml)
  if (old) parent.replaceChild(next!, old)
  else insertInOrder(parent, next!, order)
}

/** Writes a title's text, keeping the first run's formatting when there is one. */
export function setTitleText(title: Element, text: string, vertical = false) {
  const doc = title.ownerDocument!
  const rich = ck(ck(title, 'tx'), 'rich')
  if (rich) {
    const paras = kids(rich, 'p', NS_A)
    const model = paras[0] ?? null
    const run = model ? kid(model, 'r', NS_A) : null
    for (const p of paras) rich.removeChild(p)
    for (const line of text.split('\n')) {
      const p = model ? (model.cloneNode(false) as Element) : doc.createElementNS(NS_A, 'a:p')
      const pPr = model ? kid(model, 'pPr', NS_A) : null
      if (pPr) p.appendChild(pPr.cloneNode(true))
      const r = run ? (run.cloneNode(false) as Element) : doc.createElementNS(NS_A, 'a:r')
      const rPr = run ? kid(run, 'rPr', NS_A) : null
      if (rPr) r.appendChild(rPr.cloneNode(true))
      const t = doc.createElementNS(NS_A, 'a:t')
      t.appendChild(doc.createTextNode(line))
      r.appendChild(t)
      p.appendChild(r)
      rich.appendChild(p)
    }
    return
  }
  replaceChild(title, 'tx', `<c:tx>${richXml(text, vertical)}</c:tx>`, CHART_ORDER.title!)
  if (!ck(title, 'overlay')) setVal(title, 'overlay', '0', CHART_ORDER.title!)
}

/** The chart's own title: text, or null to remove it (Excel's "Chart Title" off). */
export function setChartTitle(doc: XMLDocument, text: string | null) {
  const chart = ck(doc.documentElement!, 'chart')!
  const order = CHART_ORDER.chart!
  if (text === null || text === '') {
    removeChild(chart, 'title')
    setVal(chart, 'autoTitleDeleted', '1', order)
    return
  }
  let title = ck(chart, 'title')
  if (!title) {
    ;[title] = fragment(doc, titleXml(text))
    insertInOrder(chart, title!, order)
  } else setTitleText(title, text)
  setVal(chart, 'autoTitleDeleted', '0', order)
}

export function setLegend(doc: XMLDocument, pos: LegendPos | null) {
  const chart = ck(doc.documentElement!, 'chart')!
  if (pos === null) return removeChild(chart, 'legend')
  const legend = ck(chart, 'legend')
  if (!legend) {
    const [el] = fragment(doc, `<c:legend>${v('legendPos', pos)}<c:overlay val="0"/></c:legend>`)
    insertInOrder(chart, el!, CHART_ORDER.chart!)
    return
  }
  setVal(legend, 'legendPos', pos, CHART_ORDER.legend!)
  // A manual layout would keep the legend where it was.
  removeChild(legend, 'layout')
}

export type AxisPatch = {
  title?: string | null
  min?: number | null
  max?: number | null
  /** A number format code for the tick labels; null: linked to the data. */
  format?: string | null
  gridlines?: boolean
}

export function patchAxis(ax: Element, p: AxisPatch) {
  const order = CHART_ORDER[ax.localName!] ?? CHART_ORDER.valAx!
  if (p.title !== undefined) {
    if (p.title === null || p.title === '') removeChild(ax, 'title')
    else {
      const vertical = ['l', 'r'].includes(ck(ax, 'axPos')?.getAttribute('val') ?? '')
      const title = ck(ax, 'title')
      if (title) setTitleText(title, p.title, vertical)
      else replaceChild(ax, 'title', titleXml(p.title, vertical), order)
    }
  }
  if (p.min !== undefined || p.max !== undefined) {
    let scaling = ck(ax, 'scaling')
    if (!scaling) {
      ;[scaling] = fragment(
        ax.ownerDocument!,
        `<c:scaling>${v('orientation', 'minMax')}</c:scaling>`,
      )
      insertInOrder(ax, scaling!, order)
    }
    for (const k of ['min', 'max'] as const) {
      const val = p[k]
      if (val === undefined) continue
      if (val === null) removeChild(scaling!, k)
      else setVal(scaling!, k, String(val), CHART_ORDER.scaling!)
    }
  }
  if (p.format !== undefined) {
    const xml =
      p.format === null
        ? `<c:numFmt formatCode="General" sourceLinked="1"/>`
        : `<c:numFmt formatCode="${esc(p.format)}" sourceLinked="0"/>`
    replaceChild(ax, 'numFmt', xml, order)
  }
  if (p.gridlines !== undefined) {
    if (p.gridlines) {
      if (!ck(ax, 'majorGridlines'))
        replaceChild(ax, 'majorGridlines', '<c:majorGridlines/>', order)
    } else removeChild(ax, 'majorGridlines')
  }
}

export type LabelPatch = {
  value?: boolean
  category?: boolean
  series?: boolean
  percent?: boolean
  /** ST_DLblPos: ctr, inEnd, outEnd, inBase, t, b, l, r, bestFit. */
  position?: string | null
}

const LABEL_POSITIONS: Record<string, readonly string[]> = {
  bar: ['ctr', 'inEnd', 'outEnd', 'inBase'],
  line: ['ctr', 't', 'b', 'l', 'r'],
  pie: ['ctr', 'inEnd', 'outEnd', 'bestFit'],
  scatter: ['ctr', 't', 'b', 'l', 'r'],
  area: [],
  radar: [],
  bubble: ['ctr', 't', 'b', 'l', 'r'],
}

/** Data labels on every series of the chart (null or all-off removes them). */
export function setLabels(doc: XMLDocument, labels: LabelPatch | null) {
  const on = !!labels && !!(labels.value || labels.category || labels.series || labels.percent)
  const plotArea = ck(ck(doc.documentElement!, 'chart'), 'plotArea')!
  for (const group of cks(plotArea).filter((g) => g.localName! in SER_KIND)) {
    const kind = SER_KIND[group.localName!]!
    removeChild(group, 'dLbls')
    for (const ser of cks(group, 'ser')) {
      removeChild(ser, 'dLbls')
      if (!on) continue
      const allowed = LABEL_POSITIONS[kind] ?? []
      const pos =
        labels!.position && allowed.includes(labels!.position) ? v('dLblPos', labels!.position) : ''
      const xml = `<c:dLbls>${pos}${v('showLegendKey', 0)}${v('showVal', labels!.value ? 1 : 0)}${v('showCatName', labels!.category ? 1 : 0)}${v('showSerName', labels!.series ? 1 : 0)}${v('showPercent', labels!.percent && kind === 'pie' ? 1 : 0)}${v('showBubbleSize', 0)}${kind === 'pie' ? v('showLeaderLines', 1) : ''}</c:dLbls>`
      replaceChild(ser, 'dLbls', xml, serOrderOf(group.localName!))
    }
  }
}

/** A series' colour (`#RRGGBB`, null: automatic again): fill for bars/areas/slices, the line for lines. */
export function setSeriesColor(ser: Element, groupElement: string, color: string | null) {
  const order = serOrderOf(groupElement)
  const kind = SER_KIND[groupElement] ?? 'bar'
  const doc = ser.ownerDocument!
  if (color !== null && !/^#[0-9A-Fa-f]{6}$/.test(color))
    throw new XlsxError(`“${color}” is not a colour like #4472C4.`)
  const line = kind === 'line' || kind === 'scatter' || kind === 'radar'
  let spPr = ck(ser, 'spPr')
  if (color === null) {
    if (!spPr) return
    if (line) {
      const ln = kid(spPr, 'ln', NS_A)
      for (const k of ln ? kids(ln, undefined, NS_A).filter((x) => /Fill$/.test(x.localName!)) : [])
        ln!.removeChild(k)
    } else
      for (const k of kids(spPr, undefined, NS_A).filter((x) => /Fill$/.test(x.localName!)))
        spPr.removeChild(k)
    return
  }
  if (!spPr) {
    ;[spPr] = fragment(doc, '<c:spPr/>')
    insertInOrder(ser, spPr!, order)
  }
  const fill = () => {
    const f = doc.createElementNS(NS_A, 'a:solidFill')
    const [c] = kids(parseFragment(rgbXml(color)), undefined, NS_A)
    f.appendChild(doc.importNode(c!, true))
    return f
  }
  // a:spPr children: xfrm, custGeom/prstGeom, fill, ln, effect …: the fill goes before the line.
  const target = line
    ? (kid(spPr!, 'ln', NS_A) ?? spPr!.appendChild(doc.createElementNS(NS_A, 'a:ln')))
    : spPr!
  for (const k of kids(target as Element, undefined, NS_A).filter(
    (x) => /Fill$/.test(x.localName!) || x.localName === 'grpFill',
  ))
    (target as Element).removeChild(k)
  const anchor = line
    ? (target as Element).firstChild
    : (kid(spPr!, 'ln', NS_A) ??
      kids(spPr!, undefined, NS_A).find(
        (x) => !['xfrm', 'custGeom', 'prstGeom'].includes(x.localName!),
      ) ??
      null)
  ;(target as Element).insertBefore(fill(), anchor)
  // Per-point colours would hide the series colour (a pie's slices keep theirs).
  if (kind !== 'pie') removeChild(ser, 'dPt')
}

/** Line and scatter markers on (automatic symbol) or off. */
export function setMarkers(ser: Element, groupElement: string, on: boolean) {
  const kind = SER_KIND[groupElement] ?? 'bar'
  if (kind !== 'line' && kind !== 'scatter' && kind !== 'radar') return
  const xml = on
    ? `<c:marker>${v('symbol', kind === 'scatter' ? 'circle' : 'circle')}${v('size', 5)}</c:marker>`
    : `<c:marker>${v('symbol', 'none')}</c:marker>`
  replaceChild(ser, 'marker', xml, serOrderOf(groupElement))
}
