import { strToU8 } from 'fflate'
import { DOMParser } from '@xmldom/xmldom'
import { relsPartOf } from '../ooxml/package'
import { createCalc, type Calc } from './calc'
import {
  anchorElementOf,
  anchorsOf,
  chartFrameOf,
  chartsOn,
  CT_CHART,
  CT_DRAWING,
  drawingOf,
  drawingXml,
  EMU_PX,
  nonChartAnchors,
  NS_XDR,
  readAnchor,
  REL_CHART,
  REL_DRAWING,
  URI_CHART,
  writeAnchor,
  type ChartAnchor,
  type ChartPlacement,
  type Marker,
} from './chart-anchor'
import { themeOf } from './chart-color'
import { cacheOf, resolveRef } from './chart-data'
import { ck, cks, CHART_KINDS, readChart, type ChartKind, type ChartModel, type Grouping, type LegendPos } from './chart-read'
import {
  CHART_ORDER,
  fragment,
  hasAxes,
  insertInPlotArea,
  newChartXml,
  patchAxis,
  plotAreaInner,
  removeChild,
  serOrderOf,
  setChartTitle,
  setLabels,
  setLegend,
  setMarkers,
  setSeriesColor,
  type AxisPatch,
  type FilledSeries,
  type LabelPatch,
  type SeriesDef,
} from './chart-write'
import { MAX_COLS, MAX_ROWS, rangeName, requireRange, type Range } from './ref'
import { quoteSheet, rewriteRefs, type RefEdit } from './shift'
import { WORKSHEET_ORDER } from './sheet-order'
import { relativeTarget, XlsxError, type SheetInfo, type Workbook } from './workbook'
import { all, insertInOrder, kid, kids, make, NS_CHART, NS_MAIN, NS_R, NS_REL, REL, REL_CHARTSHEET, setText, textOf, WORKBOOK_ORDER } from './xml'

/**
 * Charts as sheet operations (the grid and the drive.sheet_chart_* tools
 * make the same ones, each one undoable transaction): insert a chart from
 * cells (into a sheet's drawing, or as a chart sheet), change its type,
 * title, series, legend, axes, data labels and colours, move or resize it,
 * delete it. Only the parts of that chart (its chart part, its drawing, the
 * relationships and content types they need) change; other charts stay byte
 * for byte. Inserting or deleting rows/columns moves chart references and
 * anchors with the cells (`shiftCharts`), as Excel does.
 */

export type ChartPosition = { from: Marker; to: Marker }

export type ChartOp =
  | {
      op: 'chart_create'
      sheet: string
      type: ChartKind
      grouping?: Grouping
      /** The cells to chart: series come from it as Excel picks them (names in the first row/column, series by columns when there are more rows). */
      range?: string
      /** Or the series themselves. */
      series?: SeriesDef[]
      /** Where it goes ("E2:L18"); default: next to the data, Excel's 5 × 3 inch. */
      at?: string | ChartPosition
      title?: string | null
      legend?: LegendPos | null
      /** Put the chart on a new chart sheet of this name instead. */
      newSheet?: string
    }
  | ({ op: 'chart_update'; sheet: string; chart: string } & ChartPatch)
  | { op: 'chart_move'; sheet: string; chart: string; to: string | ChartPosition }
  | { op: 'chart_delete'; sheet: string; chart: string }

export type ChartPatch = {
  type?: ChartKind
  grouping?: Grouping
  title?: string | null
  legend?: LegendPos | null
  series?: SeriesDef[]
  axes?: { category?: AxisPatch; value?: AxisPatch; secondary?: AxisPatch }
  labels?: LabelPatch | null
  /** One colour per series in order (`#RRGGBB`; null: automatic). */
  colors?: Array<string | null>
  markers?: boolean
}

export const isChartOp = (op: { op: string }): op is ChartOp => op.op.startsWith('chart_')

// ---------------------------------------------------------------------------
// Sheet geometry (Excel's default sizes; hidden rows/columns are 0 wide)

type Geometry = { colLeft: (c: number) => number; rowTop: (r: number) => number }

export function geometryOf(wb: Workbook, sheet: string): Geometry {
  const info = wb.requireSheet(sheet)
  if (info.kind !== 'worksheet') return { colLeft: () => 0, rowTop: () => 0 }
  const d = wb.sheet(info.name)
  const colW = (c: number) => {
    const col = d.cols.find((x) => c >= x.min && c <= x.max)
    return col?.hidden ? 0 : (col?.widthPx ?? d.defaultColPx)
  }
  const rowH = (r: number) => {
    const row = d.rows.get(r)
    return row?.hidden ? 0 : (row?.heightPx ?? d.defaultRowPx)
  }
  const cols = [0]
  const rows = [0]
  return {
    colLeft(c) {
      for (let i = cols.length; i <= Math.min(c, MAX_COLS); i++) cols.push(cols[i - 1]! + colW(i - 1))
      return cols[Math.min(c, MAX_COLS)]!
    },
    rowTop(r) {
      for (let i = rows.length; i <= Math.min(r, MAX_ROWS); i++) rows.push(rows[i - 1]! + rowH(i - 1))
      return rows[Math.min(r, MAX_ROWS)]!
    },
  }
}

/** A range "E2:L18" as a chart position covering those cells exactly. */
export function positionOf(text: string | ChartPosition): ChartPosition {
  if (typeof text !== 'string') return text
  const r = requireRange(text)
  return {
    from: { col: r.left, colOff: 0, row: r.top, rowOff: 0 },
    to: { col: r.right + 1, colOff: 0, row: r.bottom + 1, rowOff: 0 },
  }
}

/** The cells a chart covers ("E2:L18"; an edge exactly on a cell border ends before it). */
export function coveredRange(a: ChartAnchor, geo: Geometry): string | null {
  if (a.kind === 'absolute') return null
  const from = a.from
  let to: Marker
  if (a.kind === 'twoCell') to = a.to
  else {
    const x = geo.colLeft(from.col) + from.colOff / EMU_PX + a.cx / EMU_PX
    const y = geo.rowTop(from.row) + from.rowOff / EMU_PX + a.cy / EMU_PX
    let col = from.col
    while (col < MAX_COLS - 1 && geo.colLeft(col + 1) <= x) col++
    let row = from.row
    while (row < MAX_ROWS - 1 && geo.rowTop(row + 1) <= y) row++
    to = { col, colOff: Math.round((x - geo.colLeft(col)) * EMU_PX), row, rowOff: Math.round((y - geo.rowTop(row)) * EMU_PX) }
  }
  const right = to.colOff === 0 && to.col > from.col ? to.col - 1 : to.col
  const bottom = to.rowOff === 0 && to.row > from.row ? to.row - 1 : to.row
  return rangeName({ top: from.row, left: from.col, bottom, right })
}

// ---------------------------------------------------------------------------
// Finding charts

/** The chart `id` ("chart1") or name ("Chart 1") on a sheet. */
export function requireChart(wb: Workbook, sheet: string, id: string): ChartPlacement {
  const info = wb.requireSheet(sheet)
  const charts = chartsOn(wb, info)
  const k = id.trim().toLowerCase()
  const hit = charts.find((c) => c.id.toLowerCase() === k) ?? charts.find((c) => c.name.toLowerCase() === k)
  if (!hit)
    throw new XlsxError(
      charts.length === 0
        ? `“${info.name}” has no charts.`
        : `“${info.name}” has no chart “${id}” (it has ${charts.map((c) => `${c.id} “${c.name}”`).join(', ')}).`,
    )
  return hit
}

// ---------------------------------------------------------------------------
// Series from cells (Excel's Insert ▸ Chart on a selection)

/**
 * The series a range makes, the way Excel lays them out: series by columns
 * when the range has at least as many rows as columns, else by rows; the
 * first row/column holds names/categories when its cells are text (or the
 * corner is empty) and the data cells are not — a rule on cell kinds, not on
 * what the text says. Scatter: the first column (row) is the x values.
 */
export function seriesFromRange(wb: Workbook, calc: Pick<Calc, 'cell'>, sheet: string, text: string, kind: ChartKind): SeriesDef[] {
  const info = wb.requireWorksheet(sheet)
  const r = requireRange(text)
  const val = (row: number, col: number) => calc.cell(info.name, row, col).value
  const isText = (row: number, col: number) => typeof val(row, col) === 'string'
  const isBlank = (row: number, col: number) => val(row, col) === null
  const rows = r.bottom - r.top + 1
  const cols = r.right - r.left + 1
  const corner = isBlank(r.top, r.left)
  const scatter = kind === 'scatter' || kind === 'bubble'
  let headRow = rows > 1
  for (let c = r.left + (corner ? 1 : 0); c <= r.right && headRow; c++) if (!isText(r.top, c) && !isBlank(r.top, c)) headRow = false
  if (corner && rows > 1 && cols > 1) headRow = true
  let headCol = cols > 1 && !scatter
  for (let row = r.top + (headRow ? 1 : 0); row <= r.bottom && headCol; row++) if (!isText(row, r.left) && !isBlank(row, r.left)) headCol = false
  if (corner && rows > 1 && cols > 1 && !scatter) headCol = true
  // A data block that is all text has no numbers to chart.
  const top = r.top + (headRow ? 1 : 0)
  const left = r.left + (headCol ? 1 : 0)
  if (top > r.bottom || left > r.right) throw new XlsxError(`${rangeName(r)} has no numbers to chart besides its labels.`)
  const byCols = r.bottom - top + 1 >= r.right - left + 1
  const q = quoteSheet(info.name)
  const ref = (a: Range) => `${q}!${absolute(a)}`
  const out: SeriesDef[] = []
  if (byCols) {
    const catRange = headCol ? { top, bottom: r.bottom, left: r.left, right: r.left } : null
    const first = scatter && !headCol && r.right > left ? left : null
    const xRange = first !== null ? { top, bottom: r.bottom, left: first, right: first } : catRange
    for (let c = first !== null ? first + 1 : left; c <= r.right; c++) {
      const s: SeriesDef = { values: ref({ top, bottom: r.bottom, left: c, right: c }), categories: xRange ? ref(xRange) : null, name: headRow ? { ref: ref({ top: r.top, bottom: r.top, left: c, right: c }) } : null }
      if (kind === 'bubble' && c + 1 <= r.right) {
        s.sizes = ref({ top, bottom: r.bottom, left: c + 1, right: c + 1 })
        c++
      }
      out.push(s)
    }
  } else {
    const catRange = headRow ? { top: r.top, bottom: r.top, left, right: r.right } : null
    const first = scatter && !headRow && r.bottom > top ? top : null
    const xRange = first !== null ? { top: first, bottom: first, left, right: r.right } : catRange
    for (let row = first !== null ? first + 1 : top; row <= r.bottom; row++) {
      const s: SeriesDef = { values: ref({ top: row, bottom: row, left, right: r.right }), categories: xRange ? ref(xRange) : null, name: headCol ? { ref: ref({ top: row, bottom: row, left: r.left, right: r.left }) } : null }
      if (kind === 'bubble' && row + 1 <= r.bottom) {
        s.sizes = ref({ top: row + 1, bottom: row + 1, left, right: r.right })
        row++
      }
      out.push(s)
    }
  }
  if (out.length === 0) throw new XlsxError(`${rangeName(r)} has no series to chart.`)
  return out
}

const absolute = (a: Range) => {
  const c = (row: number, col: number) => `$${colLetters(col)}$${row + 1}`
  return a.top === a.bottom && a.left === a.right ? c(a.top, a.left) : `${c(a.top, a.left)}:${c(a.bottom, a.right)}`
}
const colLetters = (col: number) => rangeName({ top: 0, left: col, bottom: 0, right: col }).replace(/\d+/g, '')

/** A reference given by a person or the agent: "B2:B9" on `sheet`, or with its sheet; checked and made absolute. */
export function normalizeRef(wb: Workbook, sheet: string, text: string): string {
  const t = text.trim().replace(/^=/, '')
  const withSheet = t.includes('!') ? t : `${quoteSheet(sheet)}!${t}`
  const ref = resolveRef(wb, withSheet)
  if (!ref) throw new XlsxError(`“${text}” is not a range of cells in this workbook (like B2:B9 or Sheet1!B2:B9).`)
  const q = quoteSheet(ref.sheet)
  const parts = ref.ranges.map((r) => `${q}!${absolute(r)}`)
  return parts.length === 1 ? parts[0]! : `(${parts.join(',')})`
}

function fill(wb: Workbook, calc: Pick<Calc, 'cell'>, sheet: string, defs: SeriesDef[], idxs: number[]): FilledSeries[] {
  return defs.map((d, i) => {
    if (!d.values) throw new XlsxError(`Series ${i + 1} needs its values (a range like B2:B9).`)
    if (d.type && !CHART_KINDS.includes(d.type)) throw new XlsxError(`“${d.type}” is not a chart type.`)
    const values = normalizeRef(wb, sheet, d.values)
    const categories = d.categories ? normalizeRef(wb, sheet, d.categories) : null
    const sizes = d.sizes ? normalizeRef(wb, sheet, d.sizes) : null
    const name = d.name && 'ref' in d.name ? { ref: normalizeRef(wb, sheet, d.name.ref) } : (d.name ?? null)
    const catStr = categories ? cacheOf(wb, calc, categories, 'str') : null
    const catNum = categories ? cacheOf(wb, calc, categories, 'num') : null
    const catNumeric = !!catNum && catNum.length > 0 && catNum.every((v) => v !== null)
    const nameCache = name && 'ref' in name ? (cacheOf(wb, calc, name.ref, 'str') ?? []).filter((v) => v !== null).join(' ') : null
    return {
      ...d,
      values,
      categories,
      sizes,
      name,
      idx: idxs[i]!,
      valCache: (cacheOf(wb, calc, values, 'num') ?? []) as Array<number | null>,
      catCache: catNumeric ? catNum : catStr,
      catNumeric,
      nameCache,
      sizeCache: sizes ? ((cacheOf(wb, calc, sizes, 'num') ?? []) as Array<number | null>) : null,
    }
  })
}

// ---------------------------------------------------------------------------
// Running

export function runChartOp(wb: Workbook, op: ChartOp): { sheets: string[]; focus?: string } {
  switch (op.op) {
    case 'chart_create':
      return createChart(wb, op)
    case 'chart_update':
      return updateChart(wb, op)
    case 'chart_move':
      return moveChart(wb, op)
    case 'chart_delete':
      return deleteChart(wb, op)
  }
}

function freePart(wb: Workbook, dir: string, base: string): string {
  for (let n = 1; ; n++) {
    const p = `${dir}/${base}${n}.xml`
    if (!wb.pkg.has(p)) return p
  }
}

function addRel(wb: Workbook, source: string, type: string, target: string): string {
  wb.touch(relsPartOf(source))
  return wb.pkg.addRelationship(source, type, relativeTarget(source, target))
}

/** The sheet's drawing part, made (with its relationship and `<drawing>` element) when it has none. */
function ensureDrawing(wb: Workbook, info: SheetInfo): string {
  const have = drawingOf(wb, info)
  if (have) return have
  const dir = wb.part.slice(0, wb.part.lastIndexOf('/'))
  const part = freePart(wb, `${dir}/drawings`, 'drawing')
  wb.write(part, strToU8(drawingXml()), CT_DRAWING)
  const relId = addRel(wb, info.part, REL_DRAWING, part)
  const doc = wb.edit(info.part)
  const root = doc.documentElement!
  const el = make(doc, 'drawing')
  const prefix = root.lookupPrefix(NS_R)
  if (!prefix) root.setAttribute('xmlns:r', NS_R)
  el.setAttributeNS(NS_R, `${prefix ?? 'r'}:id`, relId)
  insertInOrder(root, el, info.kind === 'chartsheet' ? CHARTSHEET_ORDER : WORKSHEET_ORDER)
  return part
}

/** CT_Chartsheet's children (§18.3.1.12). */
const CHARTSHEET_ORDER = ['sheetPr', 'sheetViews', 'sheetProtection', 'customSheetViews', 'pageMargins', 'pageSetup', 'headerFooter', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'webPublishItems', 'extLst']

const markerXml = (tag: string, m: Marker) =>
  `<xdr:${tag}><xdr:col>${m.col}</xdr:col><xdr:colOff>${Math.round(m.colOff)}</xdr:colOff><xdr:row>${m.row}</xdr:row><xdr:rowOff>${Math.round(m.rowOff)}</xdr:rowOff></xdr:${tag}>`

function frameXml(id: number, name: string, relId: string) {
  return `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${name}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${URI_CHART}"><c:chart xmlns:c="${NS_CHART}" xmlns:r="${NS_R}" r:id="${relId}"/></a:graphicData></a:graphic></xdr:graphicFrame>`
}

function appendAnchor(doc: XMLDocument, xml: string) {
  const parsed = new DOMParser().parseFromString(
    `<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${xml}</xdr:wsDr>`,
    'application/xml',
  ) as unknown as XMLDocument
  for (const el of kids(parsed.documentElement!, undefined, NS_XDR)) doc.documentElement!.appendChild(doc.importNode(el, true))
}

/** The next free drawing object id and "Chart n" name in a drawing. */
function nextFrame(doc: XMLDocument): { id: number; name: string } {
  const ids = all(doc, 'cNvPr', NS_XDR).map((e) => Number(e.getAttribute('id') ?? 0))
  const names = new Set(all(doc, 'cNvPr', NS_XDR).map((e) => e.getAttribute('name') ?? ''))
  let n = 1
  while (names.has(`Chart ${n}`)) n++
  return { id: Math.max(1, ...ids) + 1, name: `Chart ${n}` }
}

/** Excel's default chart: 5 × 3 inches, placed a column to the right of the data. */
function defaultPosition(wb: Workbook, sheet: string, near: Range | null): ChartPosition {
  const geo = geometryOf(wb, sheet)
  const col = near ? near.right + 2 : 1
  const row = near ? near.top : 1
  const x = geo.colLeft(col)
  const y = geo.rowTop(row)
  const to = (px: number, py: number): Marker => {
    let c = col
    while (geo.colLeft(c + 1) <= px && c < MAX_COLS - 1) c++
    let r = row
    while (geo.rowTop(r + 1) <= py && r < MAX_ROWS - 1) r++
    return { col: c, colOff: Math.round((px - geo.colLeft(c)) * EMU_PX), row: r, rowOff: Math.round((py - geo.rowTop(r)) * EMU_PX) }
  }
  return { from: { col, colOff: 0, row, rowOff: 0 }, to: to(x + 480, y + 288) }
}

function dataRangeOf(defs: SeriesDef[], wb: Workbook): Range | null {
  let out: Range | null = null
  for (const d of defs)
    for (const f of [d.values, d.categories, d.sizes]) {
      const ref = f ? resolveRef(wb, f) : null
      for (const r of ref?.ranges ?? [])
        out = out ? { top: Math.min(out.top, r.top), left: Math.min(out.left, r.left), bottom: Math.max(out.bottom, r.bottom), right: Math.max(out.right, r.right) } : r
    }
  return out
}

function createChart(wb: Workbook, op: Extract<ChartOp, { op: 'chart_create' }>) {
  if (!CHART_KINDS.includes(op.type)) throw new XlsxError(`“${op.type}” is not a chart type (${CHART_KINDS.join(', ')}).`)
  const calc = createCalc(wb)
  const info = wb.requireSheet(op.sheet)
  if (!op.range && !op.series?.length) throw new XlsxError('A chart needs its data: a range or series.')
  if (op.range && info.kind !== 'worksheet') throw new XlsxError(`“${info.name}” is a chart sheet; give the series with their sheet.`)
  const defs = op.series?.length ? op.series : seriesFromRange(wb, calc, info.name, op.range!, op.type)
  const series = fill(wb, calc, info.name, defs, defs.map((_, i) => i))
  const singleName = series.length === 1 ? (series[0]!.nameCache ?? (series[0]!.name && 'text' in series[0]!.name ? series[0]!.name.text : null)) : null
  const title = op.title !== undefined ? op.title : (singleName ?? 'Chart Title')
  const legend = op.legend !== undefined ? op.legend : hasAxes(op.type) && series.length < 2 ? null : hasAxes(op.type) ? 'b' : 'r'
  const xml = newChartXml({ type: op.type, grouping: op.grouping, series, title, legend })
  const dir = wb.part.slice(0, wb.part.lastIndexOf('/'))
  const chartPart = freePart(wb, `${dir}/charts`, 'chart')
  wb.write(chartPart, strToU8(xml), CT_CHART)
  if (op.newSheet) return createChartSheet(wb, op.newSheet, chartPart)
  if (info.kind !== 'worksheet') throw new XlsxError(`“${info.name}” already holds its chart; add charts to a sheet of cells.`)
  const drawing = ensureDrawing(wb, info)
  const relId = addRel(wb, drawing, REL_CHART, chartPart)
  const doc = wb.edit(drawing)
  const pos = op.at ? positionOf(op.at) : defaultPosition(wb, info.name, op.range ? requireRange(op.range) : dataRangeOf(series, wb))
  const { id, name } = nextFrame(doc)
  appendAnchor(doc, `<xdr:twoCellAnchor>${markerXml('from', pos.from)}${markerXml('to', pos.to)}${frameXml(id, name, relId)}<xdr:clientData/></xdr:twoCellAnchor>`)
  wb.forgetSheet(info.part)
  return { sheets: [info.name] }
}

function createChartSheet(wb: Workbook, nameIn: string, chartPart: string) {
  const name = nameIn.trim()
  if (!name || name.length > 31 || /[\\/?*[\]:]/.test(name) || wb.findSheet(name)) throw new XlsxError(`“${nameIn}” can't be a new sheet's name (empty, too long, a character Excel doesn't allow, or taken).`)
  const dir = wb.part.slice(0, wb.part.lastIndexOf('/'))
  const part = freePart(wb, `${dir}/chartsheets`, 'sheet')
  const drawing = freePart(wb, `${dir}/drawings`, 'drawing')
  wb.write(drawing, strToU8(drawingXml()), CT_DRAWING)
  wb.write(part, strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<chartsheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheetPr/><sheetViews><sheetView zoomScale="100" workbookViewId="0" zoomToFit="1"/></sheetViews><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></chartsheet>`), 'application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml')
  const relId = addRel(wb, wb.part, REL_CHARTSHEET, part)
  const root = wb.edit(wb.part).documentElement!
  const doc = root.ownerDocument!
  const el = make(doc, 'sheet')
  el.setAttribute('name', name)
  el.setAttribute('sheetId', String(Math.max(0, ...wb.sheets().map((s) => s.sheetId)) + 1))
  const rPrefix = root.lookupPrefix(NS_R)
  if (!rPrefix) root.setAttribute('xmlns:r', NS_R)
  el.setAttributeNS(NS_R, `${rPrefix ?? 'r'}:id`, relId)
  let sheets = kid(root, 'sheets')
  if (!sheets) {
    sheets = make(doc, 'sheets')
    insertInOrder(root, sheets, WORKBOOK_ORDER)
  }
  sheets.appendChild(el)
  wb.invalidate()
  const sheetDoc = wb.edit(part)
  const dRel = addRel(wb, part, REL_DRAWING, drawing)
  const d = make(sheetDoc, 'drawing')
  d.setAttributeNS(NS_R, 'r:id', dRel)
  insertInOrder(sheetDoc.documentElement!, d, CHARTSHEET_ORDER)
  const cRel = addRel(wb, drawing, REL_CHART, chartPart)
  const ddoc = wb.edit(drawing)
  // Excel's chart sheet: the page-sized frame at the origin.
  appendAnchor(ddoc, `<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="8666049" cy="6293304"/>${frameXml(2, 'Chart 1', cRel)}<xdr:clientData/></xdr:absoluteAnchor>`)
  return { sheets: [name], focus: name }
}

/** The chart part's document for editing, and its model as it is now. */
function chartDoc(wb: Workbook, c: ChartPlacement): { doc: XMLDocument; model: ChartModel } {
  return { doc: wb.edit(c.part), model: readChart(wb.pkg.xml(c.part), themeOf(wb)) }
}

const GROUP_NAMES = new Set(['barChart', 'bar3DChart', 'lineChart', 'line3DChart', 'areaChart', 'area3DChart', 'pieChart', 'pie3DChart', 'doughnutChart', 'ofPieChart', 'scatterChart', 'bubbleChart', 'radarChart', 'stockChart', 'surfaceChart', 'surface3DChart'])
const AXIS_NAMES = new Set(['catAx', 'valAx', 'dateAx', 'serAx'])

/** The chart's series as definitions (references), for a change that keeps what is not given. */
export function seriesDefsOf(model: ChartModel): SeriesDef[] {
  const first = model.plots[0]?.kind
  return model.plots.flatMap((p) =>
    p.series.map((s) => ({
      values: s.val?.formula ?? '',
      categories: s.cat?.formula ?? null,
      name: s.name.formula ? { ref: s.name.formula } : s.name.text ? { text: s.name.text } : null,
      sizes: s.size?.formula ?? null,
      type: p.kind === first ? undefined : p.kind,
      secondary: p.secondary || undefined,
    })),
  )
}

function updateChart(wb: Workbook, op: Extract<ChartOp, { op: 'chart_update' }>) {
  const c = requireChart(wb, op.sheet, op.chart)
  const { doc, model } = chartDoc(wb, c)
  if (model.unsupported.length > 0 && (op.type || op.series || op.grouping))
    throw new XlsxError(`This chart has a kind this editor doesn't change (${model.unsupported.join(', ')}); change it in Excel.`)
  if (op.type && !CHART_KINDS.includes(op.type)) throw new XlsxError(`“${op.type}” is not a chart type (${CHART_KINDS.join(', ')}).`)
  if (op.type !== undefined || op.series !== undefined || op.grouping !== undefined) {
    const defs = op.series ?? seriesDefsOf(model)
    if (defs.some((d) => !d.values)) throw new XlsxError('A series of this chart has no cell reference for its values; give the series again.')
    const type = op.type ?? model.plots[0]?.kind ?? 'column'
    // A new type for the chart applies to every series (Excel's Change Chart Type on the chart); combos come from per-series types.
    const typed = op.type && !op.series ? defs.map((d) => ({ ...d, type: undefined, secondary: hasAxes(op.type!) ? d.secondary : undefined })) : defs
    const old = model.plots.flatMap((p) => p.series.map((s) => s.idx))
    // The i-th series keeps the i-th old series' idx (its colour and formatting); new ones get fresh ones.
    const idxs = typed.map((_, i) => old[i] ?? -1)
    const grouping = op.grouping ?? (op.type ? undefined : model.plots[0]?.grouping)
    rebuild(doc, type, grouping, fill(wb, createCalc(wb), c.sheet, typed, uniqueIdxs(idxs)))
  }
  if (op.title !== undefined) setChartTitle(doc, op.title)
  if (op.legend !== undefined) setLegend(doc, op.legend)
  if (op.axes) patchAxes(doc, op.axes)
  if (op.labels !== undefined) setLabels(doc, op.labels)
  if (op.colors || op.markers !== undefined) {
    const plotArea = ck(ck(doc.documentElement!, 'chart'), 'plotArea')!
    const sers = cks(plotArea)
      .filter((g) => GROUP_NAMES.has(g.localName!))
      .flatMap((g) => cks(g, 'ser').map((s) => ({ s, g: g.localName! })))
      .sort((a, b) => Number(ck(a.s, 'order')?.getAttribute('val') ?? 0) - Number(ck(b.s, 'order')?.getAttribute('val') ?? 0))
    if (op.colors && op.colors.length > sers.length) throw new XlsxError(`The chart has ${sers.length} series; ${op.colors.length} colours were given.`)
    op.colors?.forEach((color, i) => {
      if (color !== undefined) setSeriesColor(sers[i]!.s, sers[i]!.g, color)
    })
    if (op.markers !== undefined) for (const { s, g } of sers) setMarkers(s, g, op.markers)
  }
  return { sheets: [c.sheet] }
}

const uniqueIdxs = (idxs: number[]) => {
  const seen = new Set<number>()
  let next = Math.max(-1, ...idxs) + 1
  return idxs.map((i) => {
    const v = seen.has(i) || i < 0 ? next++ : i
    seen.add(v)
    return v
  })
}

type AxisRole = 'primaryCat' | 'primaryVal' | 'secondaryCat' | 'secondaryVal'

/** The axes of a plot area by role (the first group with axes is primary). */
function axisRoles(plotArea: Element): Map<AxisRole, Element> {
  const axes = new Map(cks(plotArea).filter((e) => AXIS_NAMES.has(e.localName!)).map((e) => [Number(ck(e, 'axId')?.getAttribute('val')), e]))
  const out = new Map<AxisRole, Element>()
  let primaryVal: number | null = null
  for (const g of cks(plotArea).filter((e) => GROUP_NAMES.has(e.localName!))) {
    const ids = cks(g, 'axId').map((a) => Number(a.getAttribute('val')))
    if (ids.length < 2) continue
    const scatter = g.localName === 'scatterChart' || g.localName === 'bubbleChart'
    const els = ids.map((id) => axes.get(id)).filter((e): e is Element => !!e)
    const valEl = scatter ? els.find((e) => ['l', 'r'].includes(ck(e, 'axPos')?.getAttribute('val') ?? '')) : els.find((e) => e.localName === 'valAx')
    const catEl = els.find((e) => e !== valEl) ?? null
    const valId = valEl ? Number(ck(valEl, 'axId')?.getAttribute('val')) : null
    primaryVal ??= valId
    const side = valId === primaryVal ? 'primary' : 'secondary'
    if (catEl && !out.has(`${side}Cat`)) out.set(`${side}Cat`, catEl)
    if (valEl && !out.has(`${side}Val`)) out.set(`${side}Val`, valEl)
  }
  return out
}

/** What an axis keeps when the chart is rebuilt: its title, scale, number format, gridlines, look. */
const AXIS_KEEP = ['scaling', 'delete', 'majorGridlines', 'minorGridlines', 'title', 'numFmt', 'majorTickMark', 'minorTickMark', 'tickLblPos', 'spPr', 'txPr', 'majorUnit', 'minorUnit', 'dispUnits']
/** What a series keeps (by its idx): its look, labels, trendlines, error bars. */
const SER_KEEP = ['spPr', 'invertIfNegative', 'pictureOptions', 'marker', 'dPt', 'dLbls', 'trendline', 'errBars', 'explosion', 'smooth', 'bubble3D']
const LINE_GROUPS = new Set(['lineChart', 'line3DChart', 'scatterChart', 'radarChart', 'stockChart'])

/** Rebuilds the plot area's chart groups and axes for these series, carrying formatting over. */
function rebuild(doc: XMLDocument, type: ChartKind, grouping: Grouping | undefined, series: FilledSeries[]) {
  const chart = ck(doc.documentElement!, 'chart')!
  const plotArea = ck(chart, 'plotArea')!
  const oldSer = new Map<number, { ser: Element; group: string }>()
  for (const g of cks(plotArea).filter((e) => GROUP_NAMES.has(e.localName!)))
    for (const s of cks(g, 'ser')) oldSer.set(Number(ck(s, 'idx')?.getAttribute('val')), { ser: s, group: g.localName! })
  const oldAxes = axisRoles(plotArea)
  for (const e of cks(plotArea)) if (GROUP_NAMES.has(e.localName!) || AXIS_NAMES.has(e.localName!)) plotArea.removeChild(e)
  for (const el of fragment(doc, plotAreaInner(type, grouping, series))) insertInPlotArea(plotArea, el)
  // Series formatting, by idx.
  for (const g of cks(plotArea).filter((e) => GROUP_NAMES.has(e.localName!))) {
    const order = serOrderOf(g.localName!)
    const sameFamily = (a: string) => LINE_GROUPS.has(a) === LINE_GROUPS.has(g.localName!)
    for (const s of cks(g, 'ser')) {
      const old = oldSer.get(Number(ck(s, 'idx')?.getAttribute('val')))
      if (!old) continue
      for (const name of SER_KEEP) {
        if (!order.includes(name)) continue
        const from = ck(old.ser, name)
        if (!from) continue
        if (name === 'spPr' && !sameFamily(old.group)) continue
        if ((name === 'marker' || name === 'smooth') && !sameFamily(old.group)) continue
        const copy = from.cloneNode(true) as Element
        if (name === 'dLbls') removeChild(copy, 'dLblPos')
        const mine = ck(s, name)
        if (mine) s.replaceChild(copy, mine)
        else insertInOrder(s, copy, order)
      }
    }
  }
  // Axis titles, scales and formats, by role.
  const now = axisRoles(plotArea)
  for (const [role, el] of now) {
    const old = oldAxes.get(role)
    if (!old) continue
    const order = CHART_ORDER[el.localName!]!
    for (const name of AXIS_KEEP) {
      if (!order.includes(name)) continue
      const from = ck(old, name)
      const mine = ck(el, name)
      if (!from) {
        if (mine && (name === 'majorGridlines' || name === 'title')) el.removeChild(mine)
        continue
      }
      const copy = from.cloneNode(true) as Element
      if (mine) el.replaceChild(copy, mine)
      else insertInOrder(el, copy, order)
    }
  }
}

function patchAxes(doc: XMLDocument, axes: NonNullable<ChartPatch['axes']>) {
  const plotArea = ck(ck(doc.documentElement!, 'chart'), 'plotArea')!
  const roles = axisRoles(plotArea)
  const want: Array<[AxisRole, AxisPatch | undefined]> = [
    ['primaryCat', axes.category],
    ['primaryVal', axes.value],
    ['secondaryVal', axes.secondary],
  ]
  for (const [role, patch] of want) {
    if (!patch) continue
    const el = roles.get(role)
    if (!el) throw new XlsxError(role === 'secondaryVal' ? 'This chart has no secondary axis.' : 'This chart has no axes (a pie or doughnut).')
    patchAxis(el, patch)
  }
}

function moveChart(wb: Workbook, op: Extract<ChartOp, { op: 'chart_move' }>) {
  const c = requireChart(wb, op.sheet, op.chart)
  if (c.anchor.kind === 'absolute') throw new XlsxError('A chart sheet’s chart fills its sheet; it has no position to change.')
  const pos = positionOf(op.to)
  if (pos.to.col < pos.from.col || pos.to.row < pos.from.row) throw new XlsxError('A chart’s end lies before its start.')
  const doc = wb.edit(c.drawing)
  const el = anchorElementOf(wb, doc, c.drawing, c.part)!
  const geo = geometryOf(wb, c.sheet)
  const px = (m: Marker) => ({ x: geo.colLeft(m.col) + m.colOff / EMU_PX, y: geo.rowTop(m.row) + m.rowOff / EMU_PX })
  const a = px(pos.from)
  const b = px(pos.to)
  writeAnchor(el, pos, { cx: Math.max(0, b.x - a.x) * EMU_PX, cy: Math.max(0, b.y - a.y) * EMU_PX })
  return { sheets: [c.sheet] }
}

/** Every part reachable from `start` (start included). */
function reachable(wb: Workbook, start: string): Set<string> {
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length) {
    const p = stack.pop()!
    if (seen.has(p) || (p !== '/' && !wb.pkg.has(p))) continue
    seen.add(p)
    for (const r of wb.pkg.relationships(p)) if (!r.external && r.part) stack.push(r.part)
  }
  return seen
}

function removeRel(wb: Workbook, source: string, id: string) {
  const rels = relsPartOf(source)
  if (!wb.pkg.has(rels)) return
  const doc = wb.edit(rels)
  for (const r of kids(doc.documentElement!, 'Relationship', NS_REL)) if (r.getAttribute('Id') === id) doc.documentElement!.removeChild(r)
}

function deleteChart(wb: Workbook, op: Extract<ChartOp, { op: 'chart_delete' }>) {
  const c = requireChart(wb, op.sheet, op.chart)
  const info = wb.requireSheet(c.sheet)
  if (info.kind === 'chartsheet') throw new XlsxError(`“${info.name}” is a chart sheet: delete the sheet to delete its chart.`)
  const doc = wb.edit(c.drawing)
  const el = anchorElementOf(wb, doc, c.drawing, c.part)!
  const relId = chartFrameOf(el)!.chart.getAttributeNS(NS_R, 'id') ?? ''
  doc.documentElement!.removeChild(el)
  removeRel(wb, c.drawing, relId)
  // The chart's own parts (style, colours, shapes on it) go when nothing else uses them.
  const owned = reachable(wb, c.part)
  const live = reachable(wb, '/')
  for (const p of owned) {
    if (live.has(p)) continue
    wb.remove(p)
    wb.remove(relsPartOf(p))
  }
  // An empty drawing goes too, with the sheet's pointer to it.
  if (anchorsOf(doc).length === 0) {
    const sheetRoot = wb.edit(info.part).documentElement!
    const d = kids(sheetRoot, 'drawing')[0]
    if (d) {
      removeRel(wb, info.part, d.getAttributeNS(NS_R, 'id') ?? '')
      sheetRoot.removeChild(d)
    }
    wb.remove(c.drawing)
    wb.remove(relsPartOf(c.drawing))
  }
  wb.forgetSheet(info.part)
  return { sheets: [c.sheet] }
}

// ---------------------------------------------------------------------------
// Rows and columns moving under charts

function shiftMarker(m: Marker, axis: 'row' | 'col', at: number, count: number, insert: boolean): Marker {
  const key = axis === 'row' ? 'row' : 'col'
  const off = axis === 'row' ? 'rowOff' : 'colOff'
  const i = m[key]
  if (insert) return i >= at ? { ...m, [key]: i + count } : m
  if (i >= at + count) return { ...m, [key]: i - count }
  if (i >= at) return { ...m, [key]: at, [off]: 0 }
  return m
}

/**
 * Inserting or deleting rows/columns on `info`: every chart's references
 * follow the cells (`#REF!` when they are deleted, as in Excel), and the
 * charts anchored on this sheet move (and size) with their cells as their
 * anchor says (`editAs`: twoCell moves and sizes, oneCell moves, absolute stays).
 */
export function shiftCharts(wb: Workbook, info: SheetInfo, edit: RefEdit, axis: 'row' | 'col', at: number, count: number, insert: boolean) {
  for (const p of wb.pkg.partNames()) {
    let type: string
    try {
      type = wb.pkg.contentType(p)
    } catch {
      continue
    }
    if (type !== CT_CHART) continue
    const changes = all(wb.pkg.xml(p), 'f', NS_CHART).flatMap((f) => {
      const t = textOf(f)
      const next = t ? rewriteRefs(t, '\u0000', edit) : t
      return next !== t ? [{ f, next }] : []
    })
    if (changes.length === 0) continue
    const doc = wb.edit(p)
    for (const c of changes) setText(doc, c.f, c.next)
  }
  const drawing = drawingOf(wb, info)
  if (!drawing) return
  const placed = chartsOn(wb, info)
  if (placed.length === 0) return
  const doc = wb.edit(drawing)
  for (const a of anchorsOf(doc)) {
    if (!chartFrameOf(a)) continue
    const anchor = readAnchor(a)
    if (anchor.kind === 'absolute' || (anchor.kind === 'twoCell' && anchor.editAs === 'absolute')) continue
    const from = shiftMarker(anchor.from, axis, at, count, insert)
    if (anchor.kind === 'oneCell') writeAnchor(a, { from, to: from })
    else if (anchor.editAs === 'oneCell') {
      const k = axis === 'row' ? 'row' : 'col'
      writeAnchor(a, { from, to: { ...anchor.to, [k]: anchor.to[k] + (from[k] - anchor.from[k]) } })
    } else writeAnchor(a, { from, to: shiftMarker(anchor.to, axis, at, count, insert) })
  }
}

/** Drawings on a sheet that hold objects other than charts (pictures, shapes): those don't move with cells here. */
export function drawingsWithOtherObjects(wb: Workbook, info: SheetInfo): number {
  return wb.pkg
    .relationships(info.part)
    .filter((r) => r.type === REL_DRAWING && !r.external && r.part && wb.pkg.has(r.part))
    .filter((r) => {
      const doc = wb.pkg.xml(r.part!)
      // An empty drawing still counts: what Excel puts there is not known to be a chart.
      return anchorsOf(doc).length === 0 || nonChartAnchors(doc) > 0
    }).length
}

// ---------------------------------------------------------------------------
// Describing charts (drive.sheet_chart_list, drive.sheet_read)

export type ChartSummary = {
  id: string
  name: string
  sheet: string
  /** The chart's type(s): one per chart group ("column", "line" …), the first is the chart's own. */
  types: string[]
  grouping: string | null
  title: string | null
  /** The cells it covers ("E2:L18"); null on a chart sheet. */
  position: string | null
  legend: LegendPos | null
  series: Array<{ name: string | null; name_ref?: string; values: string | null; categories: string | null; sizes?: string | null; type: string; secondary: boolean }>
  axes: Array<{ role: string; title: string | null; min: number | null; max: number | null; format: string | null; gridlines: boolean }>
  labels: boolean
  /** Chart kinds in it this editor doesn't draw or change (kept as they are). */
  unsupported?: string[]
}

export function describeCharts(wb: Workbook, sheet?: string): ChartSummary[] {
  const theme = themeOf(wb)
  const sheets = sheet ? [wb.requireSheet(sheet)] : wb.sheets()
  return sheets.flatMap((info) => {
    const geo = info.kind === 'worksheet' ? geometryOf(wb, info.name) : null
    return chartsOn(wb, info).map((c) => {
      const m = readChart(wb.pkg.xml(c.part), theme)
      const out: ChartSummary = {
        id: c.id,
        name: c.name,
        sheet: c.sheet,
        types: [...new Set(m.plots.map((p) => p.kind))],
        grouping: m.plots[0] && hasAxes(m.plots[0].kind) ? m.plots[0].grouping : null,
        title: m.title,
        position: geo ? coveredRange(c.anchor, geo) : null,
        legend: m.legend?.pos ?? null,
        series: m.plots.flatMap((p) =>
          p.series.map((s) => ({
            name: s.name.text,
            ...(s.name.formula ? { name_ref: s.name.formula } : {}),
            values: s.val?.formula ?? null,
            categories: s.cat?.formula ?? null,
            ...(p.kind === 'bubble' ? { sizes: s.size?.formula ?? null } : {}),
            type: p.kind,
            secondary: p.secondary,
          })),
        ),
        axes: m.axes
          .filter((a) => !a.deleted)
          .map((a) => {
            const owner = m.plots.find((p) => p.axIds.includes(a.id))
            const val = a.kind === 'val' && !(owner && (owner.kind === 'scatter' || owner.kind === 'bubble') && (a.pos === 'b' || a.pos === 't'))
            return {
              role: `${owner?.secondary ? 'secondary' : 'primary'} ${val ? 'value' : 'category'}`,
              title: a.title,
              min: a.min,
              max: a.max,
              format: a.numFmt && !a.numFmt.linked ? a.numFmt.code : null,
              gridlines: a.majorGridlines,
            }
          }),
        labels: m.plots.some((p) => !!p.labels || p.series.some((s) => !!s.labels)),
      }
      if (m.unsupported.length) out.unsupported = m.unsupported
      return out
    })
  })
}
