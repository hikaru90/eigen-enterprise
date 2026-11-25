import type { Theme } from './chart-color'
import type { SeriesData } from './chart-data'
import type { AxisModel, ChartModel, LabelOptions, PlotModel } from './chart-read'
import { displayValue, type SheetLocale } from './format'

/**
 * A chart as marks to draw (rectangles, paths, circles, lines, text) in a
 * box of the given size: our own SVG renderer (no chart library), so the
 * same geometry is unit-tested and drawn by chart-view.svelte. It follows
 * Excel's documented behaviour where it is visible: automatic axis scaling
 * (zero-based, a step of 1/2/5×10ⁿ, headroom when the maximum sits on a
 * tick), clustered bars from gap width and overlap, stacked and 100 %
 * stacked groups, secondary value axes on the right, pie slices clockwise
 * from 12 o'clock (first slice angle), legends on any side.
 */

export type Mark =
  | {
      t: 'rect'
      x: number
      y: number
      w: number
      h: number
      fill: string
      stroke?: string
      series?: number
      point?: number
    }
  | {
      t: 'path'
      d: string
      fill: string
      stroke: string
      width: number
      dash?: boolean
      series?: number
      point?: number
    }
  | {
      t: 'circle'
      cx: number
      cy: number
      r: number
      fill: string
      stroke: string
      series?: number
      point?: number
    }
  | {
      t: 'line'
      x1: number
      y1: number
      x2: number
      y2: number
      stroke: string
      width: number
      role?: 'grid' | 'axis'
    }
  | {
      t: 'text'
      x: number
      y: number
      text: string
      anchor: 'start' | 'middle' | 'end'
      size: number
      fill: string
      weight?: number
      rotate?: number
      role: 'title' | 'axis-title' | 'tick' | 'legend' | 'label'
    }

export type Scene = {
  width: number
  height: number
  background: string | null
  marks: Mark[]
  /** Some series were drawn from the chart's cached values (their cells can't be read here). */
  cached: boolean
  /** Chart groups this renderer does not draw. */
  unsupported: string[]
}

const TEXT = '#595959'
const AXIS = '#BFBFBF'
const GRID = '#D9D9D9'
const FONT = 12

const textWidth = (s: string, size: number) => s.length * size * 0.56

type Box = { x: number; y: number; w: number; h: number }

export type LayoutOptions = { locale: SheetLocale; theme: Theme }

/** A number through a format code (General when none), the way an axis or label shows it. */
function fmt(v: number, code: string | null, locale: SheetLocale): string {
  return displayValue(v, code && code !== '' ? code : 'General', locale).text
}

/** Excel-like automatic scale: zero-based unless the data sit far from zero, a 1/2/5 step, headroom at the top. */
export function autoScale(
  dataMin: number,
  dataMax: number,
  ticks: number,
  axis: Pick<AxisModel, 'min' | 'max' | 'majorUnit'> | null,
): { min: number; max: number; step: number } {
  let lo = dataMin
  let hi = dataMax
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0
    hi = 1
  }
  if (lo === hi) {
    if (hi === 0) hi = 1
    else if (hi > 0) lo = 0
    else hi = 0
  }
  // Zero-based unless the span is small next to the values (Excel: under 1/6 of the maximum).
  if (lo > 0 && (hi - lo) / hi >= 1 / 6) lo = 0
  if (hi < 0 && (hi - lo) / -lo >= 1 / 6) hi = 0
  if (axis?.min !== null && axis?.min !== undefined) lo = axis.min
  if (axis?.max !== null && axis?.max !== undefined) hi = axis.max
  const raw = (hi - lo) / Math.max(1, ticks)
  let step = axis?.majorUnit ?? niceStep(raw)
  if (!(step > 0)) step = 1
  let min = axis?.min ?? Math.floor(lo / step) * step
  let max = axis?.max ?? Math.ceil(hi / step) * step
  if (axis?.max == null && max === dataMax && dataMax > 0) max += step
  if (axis?.min == null && min === dataMin && dataMin < 0) min -= step
  if (max <= min) max = min + step
  return { min: round(min), max: round(max), step }
}

const round = (v: number) => Math.round(v * 1e10) / 1e10

function niceStep(raw: number): number {
  if (!(raw > 0)) return 1
  const mag = 10 ** Math.floor(Math.log10(raw))
  const f = raw / mag
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag
}

function arcPath(cx: number, cy: number, r: number, inner: number, a0: number, a1: number): string {
  // Angles in radians, clockwise from 12 o'clock.
  const pt = (rad: number, a: number) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)] as const
  const large = a1 - a0 > Math.PI ? 1 : 0
  if (a1 - a0 >= Math.PI * 2 - 1e-9) {
    // A full circle: two half arcs.
    const mid = a0 + Math.PI
    return arcPath(cx, cy, r, inner, a0, mid) + ' ' + arcPath(cx, cy, r, inner, mid, a1)
  }
  const [x0, y0] = pt(r, a0)
  const [x1, y1] = pt(r, a1)
  if (inner <= 0)
    return `M${f2(cx)},${f2(cy)} L${f2(x0)},${f2(y0)} A${f2(r)},${f2(r)} 0 ${large} 1 ${f2(x1)},${f2(y1)} Z`
  const [x2, y2] = pt(inner, a1)
  const [x3, y3] = pt(inner, a0)
  return `M${f2(x0)},${f2(y0)} A${f2(r)},${f2(r)} 0 ${large} 1 ${f2(x1)},${f2(y1)} L${f2(x2)},${f2(y2)} A${f2(inner)},${f2(inner)} 0 ${large} 0 ${f2(x3)},${f2(y3)} Z`
}

const f2 = (v: number) => (Math.round(v * 100) / 100).toString()

function polyline(pts: Array<[number, number] | null>, smooth: boolean, span: boolean): string {
  const out: string[] = []
  let run: Array<[number, number]> = []
  const flush = () => {
    if (run.length === 0) return
    if (!smooth || run.length < 3)
      out.push(run.map((p, i) => `${i ? 'L' : 'M'}${f2(p[0])},${f2(p[1])}`).join(' '))
    else {
      // Catmull-Rom through the points, as cubic Béziers.
      let d = `M${f2(run[0]![0])},${f2(run[0]![1])}`
      for (let i = 0; i < run.length - 1; i++) {
        const p0 = run[Math.max(0, i - 1)]!
        const p1 = run[i]!
        const p2 = run[i + 1]!
        const p3 = run[Math.min(run.length - 1, i + 2)]!
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
        d += ` C${f2(c1[0]!)},${f2(c1[1]!)} ${f2(c2[0]!)},${f2(c2[1]!)} ${f2(p2[0])},${f2(p2[1])}`
      }
      out.push(d)
    }
    run = []
  }
  for (const p of pts) {
    if (p) run.push(p)
    else if (!span) flush()
  }
  flush()
  return out.join(' ')
}

/** The title Excel shows: the text, else the one series' name (automatic title), else "Chart Title". */
export function shownTitle(model: ChartModel, data: SeriesData[][]): string | null {
  if (model.title !== null && model.title !== '') return model.title
  const all = data.flat()
  if (model.autoTitle) return all.length === 1 ? all[0]!.name : 'Chart Title'
  if (!model.autoTitleDeleted && all.length === 1 && model.title === null) return all[0]!.name
  return null
}

type LegendEntry = { name: string; color: string; line: boolean }

function legendEntries(model: ChartModel, data: SeriesData[][]): LegendEntry[] {
  const pie = model.plots[0]
  if (
    pie &&
    (pie.kind === 'pie' || pie.kind === 'doughnut') &&
    data[0]?.[0] &&
    (pie.varyColors || model.plots.length === 1)
  ) {
    const s = data[0][0]
    return s.categories.map((c, i) => ({
      name: c,
      color: s.pointColors[i] ?? s.color,
      line: false,
    }))
  }
  return model.plots.flatMap((p, i) =>
    (data[i] ?? []).map((s) => ({
      name: s.name,
      color: s.color,
      line: p.kind === 'line' || p.kind === 'scatter' || p.kind === 'radar',
    })),
  )
}

function drawLegend(marks: Mark[], entries: LegendEntry[], pos: string, box: Box): Box {
  const size = FONT - 1
  const swatch = 10
  const rowH = size + 8
  if (entries.length === 0) return box
  if (pos === 'r' || pos === 'l' || pos === 'tr') {
    const w = Math.min(
      box.w * 0.4,
      Math.max(...entries.map((e) => textWidth(e.name, size))) + swatch + 14,
    )
    const h = entries.length * rowH
    const x = pos === 'l' ? box.x + 4 : box.x + box.w - w - 4
    let y = pos === 'tr' ? box.y + 4 : box.y + Math.max(0, (box.h - h) / 2)
    for (const e of entries) {
      legendItem(marks, e, x, y + rowH / 2, swatch, size)
      y += rowH
    }
    return pos === 'l'
      ? { x: box.x + w + 8, y: box.y, w: box.w - w - 8, h: box.h }
      : { x: box.x, y: box.y, w: box.w - w - 8, h: box.h }
  }
  // Top or bottom: entries in rows, centred.
  const widths = entries.map((e) => textWidth(e.name, size) + swatch + 16)
  const lines: number[][] = [[]]
  let used = 0
  widths.forEach((w, i) => {
    if (used + w > box.w && lines.at(-1)!.length > 0) {
      lines.push([])
      used = 0
    }
    lines.at(-1)!.push(i)
    used += w
  })
  const h = lines.length * rowH
  let y = pos === 't' ? box.y + 2 : box.y + box.h - h
  for (const line of lines) {
    const total = line.reduce((a, i) => a + widths[i]!, 0)
    let x = box.x + (box.w - total) / 2
    for (const i of line) {
      legendItem(marks, entries[i]!, x, y + rowH / 2, swatch, size)
      x += widths[i]!
    }
    y += rowH
  }
  return pos === 't'
    ? { x: box.x, y: box.y + h + 4, w: box.w, h: box.h - h - 4 }
    : { x: box.x, y: box.y, w: box.w, h: box.h - h - 4 }
}

function legendItem(
  marks: Mark[],
  e: LegendEntry,
  x: number,
  cy: number,
  swatch: number,
  size: number,
) {
  if (e.line) {
    marks.push({ t: 'line', x1: x, y1: cy, x2: x + swatch + 4, y2: cy, stroke: e.color, width: 2 })
    marks.push({
      t: 'circle',
      cx: x + (swatch + 4) / 2,
      cy,
      r: 2.5,
      fill: e.color,
      stroke: e.color,
    })
  } else marks.push({ t: 'rect', x, y: cy - swatch / 2, w: swatch, h: swatch, fill: e.color })
  marks.push({
    t: 'text',
    x: x + swatch + 8,
    y: cy + size * 0.35,
    text: e.name,
    anchor: 'start',
    size,
    fill: TEXT,
    role: 'legend',
  })
}

function labelText(
  l: LabelOptions,
  s: SeriesData,
  i: number,
  v: number,
  pct: number | null,
  locale: SheetLocale,
): string {
  const parts: string[] = []
  if (l.series) parts.push(s.name)
  if (l.category) parts.push(s.categories[i] ?? '')
  if (l.value) parts.push(fmt(v, s.formatCode, locale))
  if (l.percent && pct !== null) parts.push(`${Math.round(pct * 100)}%`)
  return parts.join(', ')
}

/** Lays the chart out in a box of `width` × `height` pixels. */
export function layoutChart(
  model: ChartModel,
  data: SeriesData[][],
  width: number,
  height: number,
  opts: LayoutOptions,
): Scene {
  const marks: Mark[] = []
  const bg = model.background === 'none' ? null : (model.background ?? '#FFFFFF')
  let box: Box = { x: 8, y: 8, w: Math.max(10, width - 16), h: Math.max(10, height - 16) }
  const title = shownTitle(model, data)
  if (title) {
    const size = 16
    const lines = title.split('\n')
    lines.forEach((line, i) =>
      marks.push({
        t: 'text',
        x: width / 2,
        y: box.y + size + i * (size + 4),
        text: line,
        anchor: 'middle',
        size,
        fill: TEXT,
        role: 'title',
      }),
    )
    const used = lines.length * (size + 4) + 6
    box = { ...box, y: box.y + used, h: box.h - used }
  }
  if (model.legend) box = drawLegend(marks, legendEntries(model, data), model.legend.pos, box)
  const cached = data.flat().some((s) => s.cached)
  if (model.plotBackground && model.plotBackground !== 'none')
    marks.push({ t: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, fill: model.plotBackground })
  const first = model.plots[0]
  if (first && (first.kind === 'pie' || first.kind === 'doughnut'))
    drawPie(marks, first, data[0] ?? [], box, opts.locale)
  else if (first && first.kind === 'radar')
    drawRadar(marks, model, first, data[0] ?? [], box, opts.locale)
  else if (first) drawAxes(marks, model, data, box, opts.locale)
  return { width, height, background: bg, marks, cached, unsupported: model.unsupported }
}

function drawPie(
  marks: Mark[],
  plot: PlotModel,
  series: SeriesData[],
  box: Box,
  locale: SheetLocale,
) {
  // Excel draws a pie's first series only; a doughnut draws every series as a ring.
  const rings = plot.kind === 'doughnut' ? series : series.slice(0, 1)
  if (rings.length === 0) return
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const r = Math.max(4, Math.min(box.w, box.h) / 2 - 6)
  const hole = plot.kind === 'doughnut' ? (r * Math.min(90, Math.max(10, plot.holeSize))) / 100 : 0
  const ringW = (r - hole) / rings.length
  rings.forEach((s, k) => {
    const outer = r - k * ringW
    const inner = outer - ringW
    const vals = s.values.map((v) => Math.abs(v ?? 0))
    const total = vals.reduce((a, b) => a + b, 0)
    if (total === 0) return
    let a = (plot.firstSliceAngle * Math.PI) / 180
    vals.forEach((v, i) => {
      if (v === 0) return
      const a1 = a + (v / total) * Math.PI * 2
      const fill = s.pointColors[i] ?? s.color
      marks.push({
        t: 'path',
        d: arcPath(cx, cy, outer, plot.kind === 'doughnut' ? inner : 0, a, a1),
        fill,
        stroke: '#FFFFFF',
        width: 1,
        series: s.idx,
        point: i,
      })
      const labels = plot.labels ?? null
      const l = labels ?? seriesLabels(s, plot)
      if (l) {
        const mid = (a + a1) / 2
        const lr =
          plot.kind === 'doughnut'
            ? (outer + inner) / 2
            : l.position === 'outEnd'
              ? outer + 12
              : outer * 0.65
        marks.push({
          t: 'text',
          x: cx + lr * Math.sin(mid),
          y: cy - lr * Math.cos(mid) + 4,
          text: labelText(l, s, i, s.values[i] ?? 0, v / total, locale),
          anchor: 'middle',
          size: FONT - 1,
          fill: l.position === 'outEnd' ? TEXT : '#FFFFFF',
          role: 'label',
        })
      }
      a = a1
    })
  })
}

/** Data labels set on the series itself (the group's labels win in drawPie / drawAxes when set). */
const seriesLabels = (s: SeriesData, plot: PlotModel): LabelOptions | null =>
  plot.series.find((x) => x.idx === s.idx)?.labels ?? null

function drawRadar(
  marks: Mark[],
  model: ChartModel,
  plot: PlotModel,
  series: SeriesData[],
  box: Box,
  locale: SheetLocale,
) {
  const cats = series[0]?.categories ?? []
  const n = cats.length
  if (n === 0) return
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2 + 4
  const r = Math.max(4, Math.min(box.w, box.h) / 2 - 22)
  const vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  const axis = model.axes.find((a) => a.kind === 'val') ?? null
  const sc = autoScale(Math.min(0, ...vals), Math.max(0, ...vals), 5, axis)
  const at = (i: number, v: number) => {
    const ang = (i / n) * Math.PI * 2
    const rr = ((v - sc.min) / (sc.max - sc.min)) * r
    return [cx + rr * Math.sin(ang), cy - rr * Math.cos(ang)] as [number, number]
  }
  for (let t = sc.min; t <= sc.max + 1e-9; t += sc.step) {
    const ring = Array.from({ length: n }, (_, i) => at(i, t))
    marks.push({
      t: 'path',
      d: polyline([...ring, ring[0]!], false, false),
      fill: 'none',
      stroke: GRID,
      width: 1,
    })
    const [lx, ly] = at(0, t)
    marks.push({
      t: 'text',
      x: lx - 4,
      y: ly + 4,
      text: fmt(
        round(t),
        axis?.numFmt && !axis.numFmt.linked ? axis.numFmt.code : (series[0]?.formatCode ?? null),
        locale,
      ),
      anchor: 'end',
      size: FONT - 2,
      fill: TEXT,
      role: 'tick',
    })
  }
  cats.forEach((c, i) => {
    const [x, y] = at(i, sc.max)
    marks.push({ t: 'line', x1: cx, y1: cy, x2: x, y2: y, stroke: GRID, width: 1, role: 'grid' })
    const ang = (i / n) * Math.PI * 2
    marks.push({
      t: 'text',
      x: cx + (r + 12) * Math.sin(ang),
      y: cy - (r + 12) * Math.cos(ang) + 4,
      text: c,
      anchor: Math.abs(Math.sin(ang)) < 0.2 ? 'middle' : Math.sin(ang) > 0 ? 'start' : 'end',
      size: FONT - 1,
      fill: TEXT,
      role: 'tick',
    })
  })
  const filled = plot.radarStyle === 'filled'
  for (const s of series) {
    const pts = s.values.map((v, i) => (v === null ? null : at(i, v)))
    const closed = pts[0] ? [...pts, pts[0]] : pts
    marks.push({
      t: 'path',
      d: polyline(closed, false, true),
      fill: filled ? s.color : 'none',
      stroke: s.color,
      width: 2,
      series: s.idx,
    })
    if (!filled && plot.radarStyle !== 'standard')
      pts.forEach(
        (p, i) =>
          p &&
          marks.push({
            t: 'circle',
            cx: p[0],
            cy: p[1],
            r: 3,
            fill: s.color,
            stroke: s.color,
            series: s.idx,
            point: i,
          }),
      )
  }
}

type ValScale = {
  min: number
  max: number
  step: number
  axis: AxisModel | null
  percent: boolean
  code: string | null
}

function drawAxes(
  marks: Mark[],
  model: ChartModel,
  data: SeriesData[][],
  box: Box,
  locale: SheetLocale,
) {
  const plots = model.plots
  const horizontal = plots.some((p) => p.kind === 'bar')
  const scatterLike = plots[0]!.kind === 'scatter' || plots[0]!.kind === 'bubble'
  const axisById = new Map(model.axes.map((a) => [a.id, a]))
  const axesOf = (p: PlotModel) =>
    p.axIds.map((id) => axisById.get(id)).filter((a): a is AxisModel => !!a)
  const valAxisOf = (p: PlotModel): AxisModel | null => {
    const xs = axesOf(p)
    if (p.kind === 'scatter' || p.kind === 'bubble')
      return xs.find((a) => a.pos === 'l' || a.pos === 'r') ?? xs[1] ?? null
    return xs.find((a) => a.kind === 'val') ?? null
  }
  const catAxisOf = (p: PlotModel): AxisModel | null => {
    const xs = axesOf(p)
    if (p.kind === 'scatter' || p.kind === 'bubble')
      return xs.find((a) => a.pos === 'b' || a.pos === 't') ?? xs[0] ?? null
    return xs.find((a) => a.kind !== 'val') ?? null
  }
  const cats = (data[0]?.[0]?.categories ?? []).slice()
  const nCat = Math.max(1, ...data.flat().map((s) => s.values.length), cats.length)
  while (cats.length < nCat) cats.push(String(cats.length + 1))

  // Value ranges, per side (primary / secondary).
  const scales: { primary: ValScale | null; secondary: ValScale | null } = {
    primary: null,
    secondary: null,
  }
  const stackedValues = (p: PlotModel, ser: SeriesData[]): number[] => {
    if (p.grouping !== 'stacked' && p.grouping !== 'percentStacked')
      return ser.flatMap((s) => s.values.filter((v): v is number => v !== null))
    const out: number[] = []
    for (let i = 0; i < nCat; i++) {
      let pos = 0
      let neg = 0
      for (const s of ser) {
        const v = s.values[i] ?? 0
        if (v >= 0) pos += v
        else neg += v
      }
      if (p.grouping === 'percentStacked') {
        const tot = pos - neg
        out.push(tot ? pos / tot : 0, tot ? neg / tot : 0)
      } else out.push(pos, neg)
    }
    return out
  }
  const sideTicks = Math.max(2, Math.min(10, Math.floor((horizontal ? box.w : box.h) / 40)))
  for (const side of ['primary', 'secondary'] as const) {
    const ps = plots
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => (side === 'secondary') === p.secondary)
    if (ps.length === 0) continue
    const vals = ps.flatMap(({ p, i }) => stackedValues(p, data[i] ?? []))
    const axis = valAxisOf(ps[0]!.p)
    const percent = ps.every(({ p }) => p.grouping === 'percentStacked')
    const lo = vals.length ? Math.min(...vals) : 0
    const hi = vals.length ? Math.max(...vals) : 1
    const sc = percent
      ? { min: Math.min(0, Math.floor(lo * 10) / 10), max: 1, step: 0.1 }
      : autoScale(lo, hi, sideTicks, axis)
    const code =
      axis?.numFmt && !axis.numFmt.linked
        ? axis.numFmt.code
        : percent
          ? '0%'
          : (data[ps[0]!.i]?.[0]?.formatCode ?? null)
    scales[side] = { ...sc, axis, percent, code }
  }
  // Scatter: the x axis is a value axis too.
  let xScale: ValScale | null = null
  if (scatterLike) {
    const xs = data
      .flat()
      .flatMap((s) => (s.x ?? s.values.map((_, i) => i + 1)).filter((v): v is number => v !== null))
    const axis = catAxisOf(plots[0]!)
    const sc = autoScale(
      Math.min(...xs),
      Math.max(...xs),
      Math.max(2, Math.floor(box.w / 70)),
      axis,
    )
    xScale = {
      ...sc,
      axis,
      percent: false,
      code: axis?.numFmt && !axis.numFmt.linked ? axis.numFmt.code : null,
    }
  }

  // Room for tick labels and axis titles.
  const prim = scales.primary
  const sec = scales.secondary
  const tickLabel = (sc: ValScale, v: number) => fmt(round(v), sc.code, locale)
  const labelsOf = (sc: ValScale | null) => {
    if (!sc) return [] as string[]
    const out: string[] = []
    for (let v = sc.min; v <= sc.max + sc.step / 1e6; v += sc.step) out.push(tickLabel(sc, v))
    return out
  }
  const catAxis = catAxisOf(plots[0]!)
  const valAxis = prim?.axis ?? null
  const secAxis = sec?.axis ?? null
  const showCat = !(catAxis?.deleted ?? false) && (catAxis?.tickLabels ?? true)
  const showVal = !(valAxis?.deleted ?? false) && (valAxis?.tickLabels ?? true)
  const showSec = !!sec && !(secAxis?.deleted ?? false) && (secAxis?.tickLabels ?? true)
  const valLabelW = showVal
    ? Math.max(0, ...labelsOf(prim).map((s) => textWidth(s, FONT - 1))) + 6
    : 0
  const secLabelW = showSec
    ? Math.max(0, ...labelsOf(sec).map((s) => textWidth(s, FONT - 1))) + 6
    : 0
  const catLabels = scatterLike ? labelsOf(xScale) : cats
  const catLabelW = Math.max(0, ...catLabels.map((s) => textWidth(s, FONT - 1)))
  const titleH = FONT + 8
  let left = box.x
  let right = box.x + box.w
  const top = box.y + 4
  let bottom = box.y + box.h
  const leftAxis = horizontal ? catAxis : valAxis
  const bottomAxis = horizontal ? valAxis : catAxis
  if (leftAxis?.title && !leftAxis.deleted) left += titleH
  if (bottomAxis?.title && !bottomAxis.deleted) bottom -= titleH
  if (secAxis?.title && !secAxis.deleted) right -= titleH
  if (horizontal) {
    left += showCat ? Math.min(box.w * 0.35, catLabelW + 8) : 0
    bottom -= showVal ? FONT + 6 : 0
  } else {
    left += valLabelW
    bottom -= showCat ? FONT + 6 : 0
  }
  right -= secLabelW
  if (right - left < 10 || bottom - top < 10) return
  const plot: Box = { x: left, y: top, w: right - left, h: bottom - top }

  // Value → pixel along the value direction.
  const valPx = (sc: ValScale, v: number) => {
    const t = (v - sc.min) / (sc.max - sc.min)
    const tt = sc.axis?.reversed ? 1 - t : t
    return horizontal ? plot.x + tt * plot.w : plot.y + plot.h - tt * plot.h
  }
  const band = (horizontal ? plot.h : plot.w) / nCat
  const catReversed = catAxis?.reversed ?? false
  const catStart = (i: number) => {
    const k = catReversed !== horizontal ? nCat - 1 - i : i
    return (horizontal ? plot.y : plot.x) + k * band
  }
  const xPx = (v: number) => {
    const sc = xScale!
    const t = (v - sc.min) / (sc.max - sc.min)
    return plot.x + (sc.axis?.reversed ? 1 - t : t) * plot.w
  }

  // Gridlines and value axis labels.
  if (prim) {
    for (let v = prim.min; v <= prim.max + prim.step / 1e6; v += prim.step) {
      const p = valPx(prim, v)
      if (valAxis?.majorGridlines ?? true)
        marks.push(
          horizontal
            ? {
                t: 'line',
                x1: p,
                y1: plot.y,
                x2: p,
                y2: plot.y + plot.h,
                stroke: GRID,
                width: 1,
                role: 'grid',
              }
            : {
                t: 'line',
                x1: plot.x,
                y1: p,
                x2: plot.x + plot.w,
                y2: p,
                stroke: GRID,
                width: 1,
                role: 'grid',
              },
        )
      if (showVal)
        marks.push(
          horizontal
            ? {
                t: 'text',
                x: p,
                y: plot.y + plot.h + FONT + 2,
                text: tickLabel(prim, v),
                anchor: 'middle',
                size: FONT - 1,
                fill: TEXT,
                role: 'tick',
              }
            : {
                t: 'text',
                x: plot.x - 4,
                y: p + 4,
                text: tickLabel(prim, v),
                anchor: 'end',
                size: FONT - 1,
                fill: TEXT,
                role: 'tick',
              },
        )
    }
  }
  if (sec && showSec) {
    for (let v = sec.min; v <= sec.max + sec.step / 1e6; v += sec.step)
      marks.push({
        t: 'text',
        x: plot.x + plot.w + 4,
        y: valPx(sec, v) + 4,
        text: tickLabel(sec, v),
        anchor: 'start',
        size: FONT - 1,
        fill: TEXT,
        role: 'tick',
      })
  }
  // The category (or x) axis.
  if (scatterLike && xScale) {
    for (let v = xScale.min; v <= xScale.max + xScale.step / 1e6; v += xScale.step) {
      const p = xPx(v)
      if (catAxis?.majorGridlines)
        marks.push({
          t: 'line',
          x1: p,
          y1: plot.y,
          x2: p,
          y2: plot.y + plot.h,
          stroke: GRID,
          width: 1,
          role: 'grid',
        })
      if (showCat)
        marks.push({
          t: 'text',
          x: p,
          y: plot.y + plot.h + FONT + 2,
          text: tickLabel(xScale, v),
          anchor: 'middle',
          size: FONT - 1,
          fill: TEXT,
          role: 'tick',
        })
    }
  } else if (showCat) {
    const every = horizontal
      ? Math.max(1, Math.ceil((FONT + 2) / band))
      : Math.max(1, Math.ceil((catLabelW + 6) / band))
    cats.forEach((c, i) => {
      if (i % every !== 0) return
      const mid = catStart(i) + band / 2
      marks.push(
        horizontal
          ? {
              t: 'text',
              x: plot.x - 4,
              y: mid + 4,
              text: c,
              anchor: 'end',
              size: FONT - 1,
              fill: TEXT,
              role: 'tick',
            }
          : {
              t: 'text',
              x: mid,
              y: plot.y + plot.h + FONT + 2,
              text: c,
              anchor: 'middle',
              size: FONT - 1,
              fill: TEXT,
              role: 'tick',
            },
      )
    })
  }
  // Axis lines at the value 0 (or the scale's edge).
  if (prim && !scatterLike) {
    const zero = valPx(prim, Math.min(Math.max(0, prim.min), prim.max))
    marks.push(
      horizontal
        ? {
            t: 'line',
            x1: zero,
            y1: plot.y,
            x2: zero,
            y2: plot.y + plot.h,
            stroke: AXIS,
            width: 1,
            role: 'axis',
          }
        : {
            t: 'line',
            x1: plot.x,
            y1: zero,
            x2: plot.x + plot.w,
            y2: zero,
            stroke: AXIS,
            width: 1,
            role: 'axis',
          },
    )
  } else if (scatterLike)
    marks.push({
      t: 'line',
      x1: plot.x,
      y1: plot.y + plot.h,
      x2: plot.x + plot.w,
      y2: plot.y + plot.h,
      stroke: AXIS,
      width: 1,
      role: 'axis',
    })
  // Axis titles.
  const axisTitle = (a: AxisModel | null, where: 'left' | 'bottom' | 'right') => {
    if (!a?.title || a.deleted) return
    if (where === 'bottom')
      marks.push({
        t: 'text',
        x: plot.x + plot.w / 2,
        y: box.y + box.h - 4,
        text: a.title,
        anchor: 'middle',
        size: FONT,
        fill: TEXT,
        weight: 600,
        role: 'axis-title',
      })
    else {
      const x = where === 'left' ? box.x + FONT : box.x + box.w - 4
      marks.push({
        t: 'text',
        x,
        y: plot.y + plot.h / 2,
        text: a.title,
        anchor: 'middle',
        size: FONT,
        fill: TEXT,
        weight: 600,
        rotate: where === 'left' ? -90 : 90,
        role: 'axis-title',
      })
    }
  }
  axisTitle(leftAxis, 'left')
  axisTitle(bottomAxis, 'bottom')
  if (sec) axisTitle(secAxis, 'right')

  // The series, group by group (bars first so lines draw on top, as Excel layers them).
  const order = plots.map((p, i) => i).sort((a, b) => rank(plots[a]!) - rank(plots[b]!))
  for (const i of order) {
    const p = plots[i]!
    const ser = data[i] ?? []
    const sc = (p.secondary ? sec : prim) ?? prim
    if (!sc) continue
    const labelsFor = (s: SeriesData) => p.labels ?? seriesLabels(s, p)
    if (p.kind === 'column' || p.kind === 'bar')
      drawBars(marks, p, ser, sc, nCat, band, catStart, valPx, horizontal, labelsFor, locale)
    else if (p.kind === 'line' || p.kind === 'area')
      drawLines(
        marks,
        p,
        ser,
        sc,
        nCat,
        band,
        catStart,
        valPx,
        model.blanks === 'span',
        labelsFor,
        locale,
      )
    else if (p.kind === 'scatter' || p.kind === 'bubble')
      drawScatter(marks, p, ser, sc, xPx, valPx, plot, labelsFor, locale)
    else if (p.kind === 'stock') drawStock(marks, ser, sc, nCat, band, catStart, valPx)
  }
}

const rank = (p: PlotModel) =>
  p.kind === 'area' ? 0 : p.kind === 'column' || p.kind === 'bar' ? 1 : 2

type CatStart = (i: number) => number
type ValPx = (sc: ValScale, v: number) => number

function shares(p: PlotModel, ser: SeriesData[], i: number): number {
  if (p.grouping !== 'percentStacked') return 1
  const tot = ser.reduce((a, s) => a + Math.abs(s.values[i] ?? 0), 0)
  return tot ? 1 / tot : 0
}

function drawBars(
  marks: Mark[],
  p: PlotModel,
  ser: SeriesData[],
  sc: ValScale,
  nCat: number,
  band: number,
  catStart: CatStart,
  valPx: ValPx,
  horizontal: boolean,
  labelsFor: (s: SeriesData) => LabelOptions | null,
  locale: SheetLocale,
) {
  const stacked = p.grouping === 'stacked' || p.grouping === 'percentStacked'
  const n = stacked ? 1 : Math.max(1, ser.length)
  const o = stacked ? 1 : Math.max(-1, Math.min(1, p.overlap / 100))
  const g = Math.max(0, Math.min(5, p.gapWidth / 100))
  const barW = band / (n - (n - 1) * o + g)
  const base = valPx(sc, Math.min(Math.max(0, sc.min), sc.max))
  for (let i = 0; i < nCat; i++) {
    let pos = 0
    let neg = 0
    const k = shares(p, ser, i)
    ser.forEach((s, j) => {
      const raw = s.values[i]
      if (raw === null || raw === undefined) return
      const v = raw * k
      let a: number
      let b: number
      if (stacked) {
        if (v >= 0) {
          a = pos
          b = pos += v
        } else {
          a = neg
          b = neg += v
        }
      } else {
        a = 0
        b = v
      }
      const start = catStart(i) + (g * barW) / 2 + (stacked ? 0 : j * barW * (1 - o))
      const pa = stacked ? valPx(sc, a) : base
      const pb = valPx(sc, b)
      const fill = s.pointColors[i] ?? s.color
      const r = horizontal
        ? { x: Math.min(pa, pb), y: start, w: Math.abs(pb - pa), h: barW }
        : { x: start, y: Math.min(pa, pb), w: barW, h: Math.abs(pb - pa) }
      marks.push({ t: 'rect', ...r, fill, series: s.idx, point: i })
      const l = labelsFor(s)
      if (l)
        marks.push(
          horizontal
            ? {
                t: 'text',
                x: Math.max(pa, pb) + 4,
                y: r.y + r.h / 2 + 4,
                text: labelText(l, s, i, raw, null, locale),
                anchor: 'start',
                size: FONT - 2,
                fill: TEXT,
                role: 'label',
              }
            : {
                t: 'text',
                x: r.x + r.w / 2,
                y: stacked ? r.y + r.h / 2 + 4 : Math.min(pa, pb) - 4,
                text: labelText(l, s, i, raw, null, locale),
                anchor: 'middle',
                size: FONT - 2,
                fill: TEXT,
                role: 'label',
              },
        )
    })
  }
}

function drawLines(
  marks: Mark[],
  p: PlotModel,
  ser: SeriesData[],
  sc: ValScale,
  nCat: number,
  band: number,
  catStart: CatStart,
  valPx: ValPx,
  span: boolean,
  labelsFor: (s: SeriesData) => LabelOptions | null,
  locale: SheetLocale,
) {
  const stacked = p.grouping === 'stacked' || p.grouping === 'percentStacked'
  const acc = new Array<number>(nCat).fill(0)
  const base = valPx(sc, Math.min(Math.max(0, sc.min), sc.max))
  const layers: Array<{
    s: SeriesData
    top: Array<[number, number] | null>
    bottom: Array<[number, number]>
  }> = []
  for (const s of ser) {
    const bottom: Array<[number, number]> = []
    const top = Array.from({ length: nCat }, (_, i): [number, number] | null => {
      const x = catStart(i) + band / 2
      const raw = s.values[i]
      bottom.push([x, stacked ? valPx(sc, acc[i]!) : base])
      if (raw === null || raw === undefined) return stacked ? [x, valPx(sc, acc[i]!)] : null
      const v = raw * shares(p, ser, i)
      if (stacked) acc[i] = acc[i]! + v
      return [x, valPx(sc, stacked ? acc[i]! : v)]
    })
    layers.push({ s, top, bottom })
  }
  for (const { s, top, bottom } of layers) {
    const ps = p.series.find((x) => x.idx === s.idx)
    if (p.kind === 'area') {
      const pts = top.map((pt, i) => pt ?? bottom[i]!)
      const d = `${polyline(pts, false, true)} ${[...bottom]
        .reverse()
        .map((b) => `L${f2(b[0])},${f2(b[1])}`)
        .join(' ')} Z`
      marks.push({ t: 'path', d, fill: s.color, stroke: 'none', width: 0, series: s.idx })
    } else {
      const line = ps?.lineColor === 'none' ? null : (ps?.lineColor ?? s.color)
      if (line)
        marks.push({
          t: 'path',
          d: polyline(top, ps?.smooth ?? false, span),
          fill: 'none',
          stroke: line,
          width: ps?.lineWidthPx ?? 2.25,
          dash: ps?.dash,
          series: s.idx,
        })
      const symbol = ps?.marker?.symbol ?? 'auto'
      if (symbol !== 'none')
        top.forEach(
          (pt, i) =>
            pt &&
            marks.push({
              t: 'circle',
              cx: pt[0],
              cy: pt[1],
              r: Math.max(2, (ps?.marker?.size ?? 5) / 2 + 0.5),
              fill: ps?.marker?.color ?? s.color,
              stroke: s.color,
              series: s.idx,
              point: i,
            }),
        )
    }
    const l = labelsFor(s)
    if (l)
      top.forEach(
        (pt, i) =>
          pt &&
          s.values[i] != null &&
          marks.push({
            t: 'text',
            x: pt[0],
            y: pt[1] - 7,
            text: labelText(l, s, i, s.values[i]!, null, locale),
            anchor: 'middle',
            size: FONT - 2,
            fill: TEXT,
            role: 'label',
          }),
      )
  }
}

function drawScatter(
  marks: Mark[],
  p: PlotModel,
  ser: SeriesData[],
  sc: ValScale,
  xPx: (v: number) => number,
  valPx: ValPx,
  plot: Box,
  labelsFor: (s: SeriesData) => LabelOptions | null,
  locale: SheetLocale,
) {
  const maxSize = Math.max(0, ...ser.flatMap((s) => (s.sizes ?? []).map((v) => Math.abs(v ?? 0))))
  const maxR = (Math.min(plot.w, plot.h) * 0.25) / 2
  for (const s of ser) {
    const ps = p.series.find((x) => x.idx === s.idx)
    const pts = s.values.map((v, i): [number, number] | null => {
      const x = s.x ? s.x[i] : i + 1
      return v === null || x === null || x === undefined ? null : [xPx(x), valPx(sc, v)]
    })
    if (p.kind === 'bubble') {
      pts.forEach((pt, i) => {
        const size = Math.abs(s.sizes?.[i] ?? 0)
        if (!pt || !maxSize) return
        marks.push({
          t: 'circle',
          cx: pt[0],
          cy: pt[1],
          r: Math.max(1, Math.sqrt(size / maxSize) * maxR),
          fill: s.pointColors[i] ?? s.color,
          stroke: '#FFFFFF',
          series: s.idx,
          point: i,
        })
      })
    } else {
      const style = p.scatterStyle ?? 'lineMarker'
      const lineOff = ps?.lineColor === 'none' || style === 'marker' || style === 'none'
      if (!lineOff)
        marks.push({
          t: 'path',
          d: polyline(pts, (ps?.smooth ?? false) || style.startsWith('smooth'), false),
          fill: 'none',
          stroke: ps?.lineColor && ps.lineColor !== 'none' ? ps.lineColor : s.color,
          width: ps?.lineWidthPx ?? 2.25,
          series: s.idx,
        })
      if ((ps?.marker?.symbol ?? 'auto') !== 'none' && style !== 'line' && style !== 'smooth')
        pts.forEach(
          (pt, i) =>
            pt &&
            marks.push({
              t: 'circle',
              cx: pt[0],
              cy: pt[1],
              r: Math.max(2, (ps?.marker?.size ?? 5) / 2 + 0.5),
              fill: ps?.marker?.color ?? s.color,
              stroke: s.color,
              series: s.idx,
              point: i,
            }),
        )
    }
    const l = labelsFor(s)
    if (l)
      pts.forEach(
        (pt, i) =>
          pt &&
          marks.push({
            t: 'text',
            x: pt[0],
            y: pt[1] - 8,
            text: labelText(l, s, i, s.values[i]!, null, locale),
            anchor: 'middle',
            size: FONT - 2,
            fill: TEXT,
            role: 'label',
          }),
      )
  }
}

/** High-low-close (three series) or open-high-low-close (four): a high–low line, open/close ticks, up/down bars for four. */
function drawStock(
  marks: Mark[],
  ser: SeriesData[],
  sc: ValScale,
  nCat: number,
  band: number,
  catStart: CatStart,
  valPx: ValPx,
) {
  const ohlc = ser.length >= 4
  const [o, h, l, c] = ohlc ? ser : [null, ser[0], ser[1], ser[2]]
  for (let i = 0; i < nCat; i++) {
    const x = catStart(i) + band / 2
    const hi = h?.values[i]
    const lo = l?.values[i]
    if (hi != null && lo != null)
      marks.push({
        t: 'line',
        x1: x,
        y1: valPx(sc, hi),
        x2: x,
        y2: valPx(sc, lo),
        stroke: '#404040',
        width: 1,
      })
    const cl = c?.values[i]
    const op = o?.values[i]
    if (ohlc && op != null && cl != null) {
      const w = band * 0.4
      const a = valPx(sc, op)
      const b = valPx(sc, cl)
      marks.push({
        t: 'rect',
        x: x - w / 2,
        y: Math.min(a, b),
        w,
        h: Math.max(1, Math.abs(a - b)),
        fill: cl >= op ? '#FFFFFF' : '#404040',
        stroke: '#404040',
        series: c?.idx,
        point: i,
      })
    } else if (cl != null)
      marks.push({
        t: 'line',
        x1: x,
        y1: valPx(sc, cl),
        x2: x + band * 0.2,
        y2: valPx(sc, cl),
        stroke: '#404040',
        width: 2,
      })
  }
}
