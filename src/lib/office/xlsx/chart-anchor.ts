import type { SheetInfo, Workbook } from './workbook'
import { all, kid, kids, NS_A, NS_CHART, NS_R, REL, textOf } from './xml'

/**
 * Where charts sit (SpreadsheetML drawing parts, ECMA-376 Part 1 §20.5):
 * a sheet (worksheet or chart sheet) points at its drawing part; each anchor
 * there (`xdr:twoCellAnchor`, `oneCellAnchor`, `absoluteAnchor`) holds one
 * object. A chart is a `xdr:graphicFrame` whose graphic data points at a
 * chart part (`c:chart r:id`). Pictures and shapes in the same drawing are
 * not this file's business: they are read past and written back untouched.
 */

export const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
export const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
export const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml'
export const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
export const REL_DRAWING = `${REL}drawing`
export const REL_CHART = `${REL}chart`
export const URI_CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
/** EMU per pixel at 96 dpi (914 400 per inch). */
export const EMU_PX = 9525

/** A cell corner plus an offset into the cell (EMU), as `xdr:from` / `xdr:to` write it. */
export type Marker = { col: number; colOff: number; row: number; rowOff: number }

export type ChartAnchor =
  | { kind: 'twoCell'; from: Marker; to: Marker; editAs: 'twoCell' | 'oneCell' | 'absolute' }
  | { kind: 'oneCell'; from: Marker; cx: number; cy: number }
  | { kind: 'absolute'; x: number; y: number; cx: number; cy: number }

export type ChartPlacement = {
  /** The chart's id: its chart part's file name ("chart1"). */
  id: string
  /** The chart part ("/xl/charts/chart1.xml"). */
  part: string
  /** The object's name in the drawing ("Chart 1"). */
  name: string
  sheet: string
  sheetKind: SheetInfo['kind']
  drawing: string
  anchor: ChartAnchor
}

const xk = (el: Element | null, name: string) => (el ? kid(el, name, NS_XDR) : null)

/** The drawing part a sheet points at (its `<drawing r:id>`), or null. */
export function drawingOf(wb: Workbook, info: SheetInfo): string | null {
  const root = wb.pkg.xml(info.part).documentElement!
  const el = kids(root, 'drawing')[0]
  if (!el) return null
  const id = el.getAttributeNS(NS_R, 'id')
  const rel = wb.pkg.relationships(info.part).find((r) => r.id === id && !r.external)
  return rel?.part && wb.pkg.has(rel.part) ? rel.part : null
}

function readMarker(el: Element | null): Marker {
  const n = (name: string) => Number(textOf(xk(el, name)) || 0)
  return { col: n('col'), colOff: n('colOff'), row: n('row'), rowOff: n('rowOff') }
}

export function readAnchor(el: Element): ChartAnchor {
  const name = el.localName
  if (name === 'twoCellAnchor') {
    const e = el.getAttribute('editAs')
    return {
      kind: 'twoCell',
      from: readMarker(xk(el, 'from')),
      to: readMarker(xk(el, 'to')),
      editAs: e === 'oneCell' || e === 'absolute' ? e : 'twoCell',
    }
  }
  const ext = xk(el, 'ext')
  const cx = Number(ext?.getAttribute('cx') ?? 0)
  const cy = Number(ext?.getAttribute('cy') ?? 0)
  if (name === 'oneCellAnchor') return { kind: 'oneCell', from: readMarker(xk(el, 'from')), cx, cy }
  const pos = xk(el, 'pos')
  return {
    kind: 'absolute',
    x: Number(pos?.getAttribute('x') ?? 0),
    y: Number(pos?.getAttribute('y') ?? 0),
    cx,
    cy,
  }
}

const ANCHORS = ['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor']

/** The anchors of a drawing (document order). */
export function anchorsOf(drawing: XMLDocument): Element[] {
  return kids(drawing.documentElement!, undefined, NS_XDR).filter((e) =>
    ANCHORS.includes(e.localName!),
  )
}

/** The chart frame of an anchor: its graphicFrame and the `c:chart` element (null: not a chart). */
export function chartFrameOf(anchor: Element): { frame: Element; chart: Element } | null {
  const frame = xk(anchor, 'graphicFrame')
  if (!frame) return null
  const chart = all(frame, 'chart', NS_CHART)[0]
  return chart ? { frame, chart } : null
}

/** The objects of a drawing that are not charts this editor places (pictures, shapes, groups, newer chart kinds). */
export function nonChartAnchors(drawing: XMLDocument): number {
  return anchorsOf(drawing).filter((a) => !chartFrameOf(a)).length
}

export const chartIdOf = (part: string) =>
  part.slice(part.lastIndexOf('/') + 1).replace(/\.xml$/i, '')

/** Every chart on a sheet (worksheet or chart sheet), in drawing order. */
export function chartsOn(wb: Workbook, info: SheetInfo): ChartPlacement[] {
  const drawing = drawingOf(wb, info)
  if (!drawing) return []
  const rels = new Map(wb.pkg.relationships(drawing).map((r) => [r.id, r]))
  const out: ChartPlacement[] = []
  for (const a of anchorsOf(wb.pkg.xml(drawing))) {
    const f = chartFrameOf(a)
    if (!f) continue
    const rel = rels.get(f.chart.getAttributeNS(NS_R, 'id') ?? '')
    if (!rel?.part || !wb.pkg.has(rel.part)) continue
    const cNvPr = xk(xk(f.frame, 'nvGraphicFramePr'), 'cNvPr')
    out.push({
      id: chartIdOf(rel.part),
      part: rel.part,
      name: cNvPr?.getAttribute('name') ?? chartIdOf(rel.part),
      sheet: info.name,
      sheetKind: info.kind,
      drawing,
      anchor: readAnchor(a),
    })
  }
  return out
}

/** Every chart of the workbook, sheet by sheet. */
export function allCharts(wb: Workbook): ChartPlacement[] {
  return wb.sheets().flatMap((s) => chartsOn(wb, s))
}

/** The anchor element of a chart (by its chart part) in its drawing. */
export function anchorElementOf(
  wb: Workbook,
  drawingDoc: XMLDocument,
  drawing: string,
  part: string,
): Element | null {
  const rels = wb.pkg.relationships(drawing)
  for (const a of anchorsOf(drawingDoc)) {
    const f = chartFrameOf(a)
    if (!f) continue
    const rel = rels.find((r) => r.id === f.chart.getAttributeNS(NS_R, 'id'))
    if (rel?.part?.toLowerCase() === part.toLowerCase()) return a
  }
  return null
}

function setMarker(el: Element, m: Marker) {
  const set = (name: string, v: number) => {
    const e = xk(el, name)
    if (!e) return
    while (e.firstChild) e.removeChild(e.firstChild)
    e.appendChild(el.ownerDocument!.createTextNode(String(Math.max(0, Math.round(v)))))
  }
  set('col', m.col)
  set('colOff', m.colOff)
  set('row', m.row)
  set('rowOff', m.rowOff)
}

/** Writes a new position into an anchor element (its kind stays; a one-cell anchor gets its size from `to`). */
export function writeAnchor(
  el: Element,
  next: { from: Marker; to: Marker } | ChartAnchor,
  size?: { cx: number; cy: number; x?: number; y?: number },
) {
  const from = 'from' in next ? next.from : null
  if (el.localName === 'twoCellAnchor' && 'to' in next) {
    setMarker(xk(el, 'from')!, next.from)
    setMarker(xk(el, 'to')!, next.to)
  } else if (el.localName === 'oneCellAnchor' && from) {
    setMarker(xk(el, 'from')!, from)
    const ext = xk(el, 'ext')
    if (ext && size) {
      ext.setAttribute('cx', String(Math.round(size.cx)))
      ext.setAttribute('cy', String(Math.round(size.cy)))
    }
  } else if (el.localName === 'absoluteAnchor' && size) {
    const pos = xk(el, 'pos')
    if (pos && size.x !== undefined && size.y !== undefined) {
      pos.setAttribute('x', String(Math.round(size.x)))
      pos.setAttribute('y', String(Math.round(size.y)))
    }
    const ext = xk(el, 'ext')
    if (ext) {
      ext.setAttribute('cx', String(Math.round(size.cx)))
      ext.setAttribute('cy', String(Math.round(size.cy)))
    }
  }
}

/** The pixel box of an anchor over a grid with these column/row start offsets (px, from A1's corner). */
export function anchorBox(
  a: ChartAnchor,
  colLeft: (c: number) => number,
  rowTop: (r: number) => number,
): { x: number; y: number; width: number; height: number } {
  if (a.kind === 'absolute')
    return { x: a.x / EMU_PX, y: a.y / EMU_PX, width: a.cx / EMU_PX, height: a.cy / EMU_PX }
  const x = colLeft(a.from.col) + a.from.colOff / EMU_PX
  const y = rowTop(a.from.row) + a.from.rowOff / EMU_PX
  if (a.kind === 'oneCell') return { x, y, width: a.cx / EMU_PX, height: a.cy / EMU_PX }
  const x2 = colLeft(a.to.col) + a.to.colOff / EMU_PX
  const y2 = rowTop(a.to.row) + a.to.rowOff / EMU_PX
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) }
}

/** The marker of a pixel position (the cell it falls in, the offset into it), from prefix offsets. */
export function markerAt(
  x: number,
  y: number,
  colLeft: (c: number) => number,
  rowTop: (r: number) => number,
  maxCol: number,
  maxRow: number,
): Marker {
  const find = (v: number, start: (i: number) => number, max: number) => {
    let lo = 0
    let hi = max
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (start(mid) <= v) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const col = find(Math.max(0, x), colLeft, maxCol)
  const row = find(Math.max(0, y), rowTop, maxRow)
  return {
    col,
    colOff: Math.round(Math.max(0, x - colLeft(col)) * EMU_PX),
    row,
    rowOff: Math.round(Math.max(0, y - rowTop(row)) * EMU_PX),
  }
}

/** A new drawing part's text, with one or more anchor snippets. */
export const drawingXml = (inner = '') =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${inner}</xdr:wsDr>`
