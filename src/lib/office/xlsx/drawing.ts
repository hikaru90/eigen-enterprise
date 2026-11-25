import { DOMParser } from '@xmldom/xmldom'
import { strToU8 } from 'fflate'
import { relsPartOf } from '../ooxml/package'
import { WORKSHEET_ORDER } from './sheet-order'
import { relativeTarget, XlsxError, type SheetData, type SheetInfo, type Workbook } from './workbook'
import { insertInOrder, kid, kids, NS_A, NS_R, REL, REL_THEME } from './xml'

/**
 * A worksheet's drawing part (SpreadsheetML Drawing, ECMA-376 Part 1 §20.5):
 * the pictures, shapes, text boxes, groups and graphic frames (charts) that
 * float over the cells, each in an anchor (two-cell, one-cell, absolute).
 *
 * This module reads every anchor into a plain model and edits anchors in
 * place on the lossless OPC layer: an anchor nobody changed keeps every
 * element and attribute, the parts of untouched sheets stay byte for byte.
 * Graphic frames (charts and other `graphicFrame` content) are read with
 * their anchor and the part their content points at (`chartPart`), and are
 * otherwise left exactly as written, so the charts code (chart-*.ts) can draw
 * and edit them on top of the same anchors.
 */

export const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
export const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
export const REL_DRAWING = `${REL}drawing`
export const REL_IMAGE = `${REL}image`
export const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml'

/** English Metric Units: 914 400 per inch, 9 525 per pixel at 96 dpi (§20.1.2.1). */
export const EMU_PER_PX = 9525
const ANCHORS = ['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'] as const

export type Marker = { col: number; colOff: number; row: number; rowOff: number }
export type EditAs = 'twoCell' | 'oneCell' | 'absolute'
export type Anchor =
  | { type: 'twoCell'; editAs: EditAs; from: Marker; to: Marker }
  | { type: 'oneCell'; from: Marker; ext: { cx: number; cy: number } }
  | { type: 'absolute'; pos: { x: number; y: number }; ext: { cx: number; cy: number } }

export type DrawingKind =
  | 'picture'
  | 'shape'
  | 'textbox'
  | 'connector'
  | 'group'
  | 'chart'
  | 'frame'
  | 'other'

/** A box in sheet pixels (from the top-left corner of A1). */
export type Box = { x: number; y: number; w: number; h: number }

export type Line = { color: string; widthPx: number; dash: boolean; arrowEnd: boolean; arrowStart: boolean }

export type DrawingObject = {
  /** The object's id in the drawing (`cNvPr id`), as text. */
  id: string
  kind: DrawingKind
  name: string
  /** Alternative text (`descr`). */
  alt: string
  hidden: boolean
  /** Rotation in degrees (clockwise), and mirroring. */
  rotation: number
  flipH: boolean
  flipV: boolean
  /** A picture: the image part, and the cropped share of each edge (0–1). */
  image?: { part: string; contentType: string } | null
  crop?: { l: number; t: number; r: number; b: number }
  /** A shape or text box: its preset geometry (`prstGeom prst`), fill, outline, text. */
  geometry?: string | null
  fill?: string | null
  line?: Line | null
  text?: string
  textColor?: string | null
  /** A graphic frame's chart part (charts) or its graphic data URI (other frames). */
  chartPart?: string | null
  graphicUri?: string | null
  /** A group's children, boxes relative to the sheet like the group's. */
  children?: Array<DrawingObject & { box: Box }>
}

export type AnchoredObject = DrawingObject & {
  /** Index among the drawing's anchors (document order = stacking order, last on top). */
  index: number
  anchor: Anchor | null
}

// ---------------------------------------------------------------------------
// Sheet geometry: cells ↔ pixels

export type Geometry = {
  colLeft(c: number): number
  rowTop(r: number): number
  colPx(c: number): number
  rowPx(r: number): number
  /** The column / row whose span holds `x` / `y`. */
  colAt(x: number): number
  rowAt(y: number): number
}

/** Prefix sums over column widths and row heights (hidden ones are 0 wide), grown as asked. */
export function makeGeometry(colPx: (c: number) => number, rowPx: (r: number) => number): Geometry {
  const cols = [0]
  const rows = [0]
  const grow = (at: number[], px: (i: number) => number, n: number) => {
    while (at.length <= n) at.push(at[at.length - 1]! + px(at.length - 1))
    return at[n]!
  }
  const find = (at: number[], px: (i: number) => number, v: number) => {
    if (v <= 0) return 0
    while (at[at.length - 1]! <= v) {
      const before = at.length
      grow(at, px, at.length)
      // A run of zero-size lines can't hold v: keep growing, the sheet edge ends it.
      if (before >= 1_100_000) break
    }
    let lo = 0
    let hi = at.length - 2
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (at[mid]! <= v) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  return {
    colLeft: (c) => grow(cols, colPx, c),
    rowTop: (r) => grow(rows, rowPx, r),
    colPx,
    rowPx,
    colAt: (x) => find(cols, colPx, x),
    rowAt: (y) => find(rows, rowPx, y),
  }
}

/** The geometry of a sheet as the grid draws it. */
export function sheetGeometry(data: SheetData): Geometry {
  return makeGeometry(
    (c) => {
      const col = data.cols.find((x) => c >= x.min && c <= x.max)
      if (col?.hidden) return 0
      return col?.widthPx ?? data.defaultColPx
    },
    (r) => {
      const row = data.rows.get(r)
      if (row?.hidden) return 0
      return row?.heightPx ?? data.defaultRowPx
    },
  )
}

const markerX = (g: Geometry, m: Marker) => g.colLeft(m.col) + Math.min(m.colOff / EMU_PER_PX, g.colPx(m.col))
const markerY = (g: Geometry, m: Marker) => g.rowTop(m.row) + Math.min(m.rowOff / EMU_PER_PX, g.rowPx(m.row))

/** Where an anchor sits, in sheet pixels. */
export function anchorBox(a: Anchor, g: Geometry): Box {
  if (a.type === 'absolute')
    return { x: a.pos.x / EMU_PER_PX, y: a.pos.y / EMU_PER_PX, w: a.ext.cx / EMU_PER_PX, h: a.ext.cy / EMU_PER_PX }
  const x = markerX(g, a.from)
  const y = markerY(g, a.from)
  if (a.type === 'oneCell') return { x, y, w: a.ext.cx / EMU_PER_PX, h: a.ext.cy / EMU_PER_PX }
  return { x, y, w: Math.max(0, markerX(g, a.to) - x), h: Math.max(0, markerY(g, a.to) - y) }
}

/** The cell marker at sheet pixel (x, y). */
export function markerAt(g: Geometry, x: number, y: number): Marker {
  const col = g.colAt(Math.max(0, x))
  const row = g.rowAt(Math.max(0, y))
  return {
    col,
    colOff: Math.round(Math.max(0, x - g.colLeft(col)) * EMU_PER_PX),
    row,
    rowOff: Math.round(Math.max(0, y - g.rowTop(row)) * EMU_PER_PX),
  }
}

/** The same kind of anchor, placed over `box`. */
export function anchorFor(a: Anchor, box: Box, g: Geometry): Anchor {
  const ext = { cx: Math.round(box.w * EMU_PER_PX), cy: Math.round(box.h * EMU_PER_PX) }
  if (a.type === 'absolute')
    return { type: 'absolute', pos: { x: Math.round(box.x * EMU_PER_PX), y: Math.round(box.y * EMU_PER_PX) }, ext }
  const from = markerAt(g, box.x, box.y)
  if (a.type === 'oneCell') return { type: 'oneCell', from, ext }
  return { type: 'twoCell', editAs: a.editAs, from, to: markerAt(g, box.x + box.w, box.y + box.h) }
}

// ---------------------------------------------------------------------------
// Reading

/** The sheet's drawing part (`<drawing r:id>`), or null. */
export function drawingPartOf(wb: Workbook, info: SheetInfo): string | null {
  const root = wb.pkg.xml(info.part).documentElement!
  const el = kid(root, 'drawing')
  const id = el?.getAttributeNS(NS_R, 'id')
  if (!id) return null
  const rel = wb.pkg.relationships(info.part).find((r) => r.id === id)
  if (!rel?.part || !wb.pkg.has(rel.part))
    throw new XlsxError(`The sheet “${info.name}” points at a drawing the workbook does not have.`)
  return rel.part
}

/** The anchor elements of a drawing (direct ones; Markup Compatibility wrappers count by their first choice). */
export function anchorElements(doc: XMLDocument): Element[] {
  return kids(doc.documentElement!, undefined).filter(
    (e) =>
      (e.namespaceURI === NS_XDR && (ANCHORS as readonly string[]).includes(e.localName!)) ||
      (e.namespaceURI === NS_MC && e.localName === 'AlternateContent'),
  )
}

const num = (el: Element | null, attr: string, d = 0) => {
  const v = el?.getAttribute(attr)
  return v === null || v === undefined || v === '' ? d : Number(v)
}
const xk = (el: Element | null, local: string) => (el ? kid(el, local, NS_XDR) : null)
const ak = (el: Element | null, local: string) => (el ? kid(el, local, NS_A) : null)

function readMarker(el: Element | null): Marker {
  const n = (local: string) => Number(xk(el, local)?.textContent ?? 0) || 0
  return { col: n('col'), colOff: n('colOff'), row: n('row'), rowOff: n('rowOff') }
}

export function readAnchor(el: Element): Anchor | null {
  if (el.namespaceURI !== NS_XDR) return null
  if (el.localName === 'twoCellAnchor') {
    const e = el.getAttribute('editAs')
    return {
      type: 'twoCell',
      editAs: e === 'oneCell' || e === 'absolute' ? e : 'twoCell',
      from: readMarker(xk(el, 'from')),
      to: readMarker(xk(el, 'to')),
    }
  }
  const ext = xk(el, 'ext')
  const size = { cx: num(ext, 'cx'), cy: num(ext, 'cy') }
  if (el.localName === 'oneCellAnchor') return { type: 'oneCell', from: readMarker(xk(el, 'from')), ext: size }
  if (el.localName === 'absoluteAnchor') {
    const pos = xk(el, 'pos')
    return { type: 'absolute', pos: { x: num(pos, 'x'), y: num(pos, 'y') }, ext: size }
  }
  return null
}

/** The anchor an mc:AlternateContent wrapper shows in this editor: its first Choice's (else Fallback's) anchor. */
function innerAnchor(el: Element): Element | null {
  if (el.namespaceURI !== NS_MC) return el
  for (const branch of kids(el, undefined)) {
    const a = kids(branch, undefined).find((e) => e.namespaceURI === NS_XDR && (ANCHORS as readonly string[]).includes(e.localName!))
    if (a) return a
  }
  return null
}

const OBJECTS = ['sp', 'grpSp', 'graphicFrame', 'cxnSp', 'pic', 'contentPart'] as const
const objectOf = (anchor: Element) =>
  kids(anchor, undefined).find((e) => e.namespaceURI === NS_XDR && (OBJECTS as readonly string[]).includes(e.localName!)) ??
  null

type Theme = Map<string, string>

function themeOf(wb: Workbook): Theme {
  const out: Theme = new Map()
  const rel = wb.pkg.relationships(wb.part).find((r) => r.type === REL_THEME && r.part)
  if (!rel?.part || !wb.pkg.has(rel.part)) return out
  const scheme = wb.pkg.xml(rel.part).getElementsByTagNameNS(NS_A, 'clrScheme')[0]
  for (const el of scheme ? kids(scheme, undefined) : []) {
    const c = kids(el, undefined)[0]
    const hex = c?.localName === 'srgbClr' ? c.getAttribute('val') : c?.getAttribute('lastClr')
    if (hex) out.set(el.localName!, hex.toUpperCase())
  }
  // The names a shape uses for the four base colours (§20.1.10.54).
  for (const [alias, base] of [['tx1', 'dk1'], ['bg1', 'lt1'], ['tx2', 'dk2'], ['bg2', 'lt2']] as const)
    if (out.has(base)) out.set(alias, out.get(base)!)
  return out
}

/** An HSL change of a colour (lumMod/lumOff, §20.1.2.3.20–21; shade/tint as darker/lighter). */
function adjust(hex: string, mods: Element[]): string {
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  let l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6
  }
  let touched = false
  for (const m of mods) {
    const v = Number(m.getAttribute('val') ?? 0) / 100_000
    if (m.localName === 'lumMod') l *= v
    else if (m.localName === 'lumOff') l += v
    else if (m.localName === 'shade') l *= v
    else if (m.localName === 'tint') l = l * v + (1 - v)
    else continue
    touched = true
  }
  if (!touched) return hex
  l = Math.min(1, Math.max(0, l))
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  if (s === 0) r = g = b = l
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue(p, q, h + 1 / 3)
    g = hue(p, q, h)
    b = hue(p, q, h - 1 / 3)
  }
  return [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
}

const PRESET_COLORS: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  gray: '808080',
  orange: 'FFA500',
}

/** A colour element's parent (solidFill, fillRef …) → "#RRGGBB", or null when it names none this reader knows. */
function colorIn(parent: Element | null, theme: Theme, phClr?: string | null): string | null {
  if (!parent) return null
  const c = kids(parent, undefined).find((e) => e.namespaceURI === NS_A)
  if (!c) return null
  let hex: string | null = null
  if (c.localName === 'srgbClr') hex = (c.getAttribute('val') ?? '').toUpperCase()
  else if (c.localName === 'sysClr') hex = (c.getAttribute('lastClr') ?? '').toUpperCase()
  else if (c.localName === 'schemeClr') {
    const v = c.getAttribute('val') ?? ''
    hex = v === 'phClr' ? (phClr?.slice(1) ?? null) : (theme.get(v) ?? null)
  } else if (c.localName === 'prstClr') hex = PRESET_COLORS[c.getAttribute('val') ?? ''] ?? null
  if (!hex || !/^[0-9A-F]{6}$/.test(hex)) return null
  return `#${adjust(hex, kids(c, undefined))}`
}

/** The shape's style references (`xdr:style`): the theme's fill, line and font colours a default shape uses. */
function styleColors(obj: Element, theme: Theme) {
  const st = xk(obj, 'style')
  return {
    fill: colorIn(ak(st, 'fillRef'), theme),
    line: colorIn(ak(st, 'lnRef'), theme),
    font: colorIn(ak(st, 'fontRef'), theme),
    hasFill: num(ak(st, 'fillRef'), 'idx') > 0,
    hasLine: num(ak(st, 'lnRef'), 'idx') > 0,
  }
}

function readFill(spPr: Element | null, theme: Theme, ref: string | null, hasRef: boolean): string | null {
  if (!spPr) return hasRef ? ref : null
  if (ak(spPr, 'noFill')) return null
  const solid = ak(spPr, 'solidFill')
  if (solid) return colorIn(solid, theme, ref)
  const grad = ak(spPr, 'gradFill')
  if (grad) {
    // A gradient is shown by its first stop's colour.
    const gs = grad.getElementsByTagNameNS(NS_A, 'gs')[0]
    return gs ? colorIn(gs, theme, ref) : null
  }
  return hasRef ? ref : null
}

function readLine(spPr: Element | null, theme: Theme, ref: string | null, hasRef: boolean): Line | null {
  const ln = ak(spPr, 'ln')
  if (ln && ak(ln, 'noFill')) return null
  const color = ln && ak(ln, 'solidFill') ? colorIn(ak(ln, 'solidFill'), theme, ref) : hasRef ? ref : null
  if (!color) return null
  const w = ln?.getAttribute('w')
  const dash = ak(ln, 'prstDash')?.getAttribute('val')
  const end = (local: string) => {
    const t = ak(ln, local)?.getAttribute('type')
    return !!t && t !== 'none'
  }
  return {
    color,
    widthPx: w ? Math.max(0.5, Number(w) / EMU_PER_PX) : 0.75 * (4 / 3),
    dash: !!dash && dash !== 'solid',
    arrowEnd: end('tailEnd'),
    arrowStart: end('headEnd'),
  }
}

function readText(txBody: Element | null): string {
  if (!txBody) return ''
  return kids(txBody, 'p', NS_A)
    .map((p) =>
      kids(p, undefined)
        .map((r) => (r.localName === 'br' ? '\n' : r.localName === 'r' || r.localName === 'fld' ? (ak(r, 't')?.textContent ?? '') : ''))
        .join(''),
    )
    .join('\n')
}

function firstRunColor(txBody: Element | null, theme: Theme): string | null {
  if (!txBody) return null
  const rPr = txBody.getElementsByTagNameNS(NS_A, 'rPr')[0] ?? txBody.getElementsByTagNameNS(NS_A, 'defRPr')[0]
  return rPr ? colorIn(ak(rPr, 'solidFill'), theme) : null
}

type ReadCtx = { wb: Workbook; part: string; theme: Theme; rels: Map<string, string | null> }

function readObject(obj: Element, ctx: ReadCtx): DrawingObject {
  const local = obj.localName!
  const nv =
    local === 'sp'
      ? xk(obj, 'nvSpPr')
      : local === 'pic'
        ? xk(obj, 'nvPicPr')
        : local === 'grpSp'
          ? xk(obj, 'nvGrpSpPr')
          : local === 'graphicFrame'
            ? xk(obj, 'nvGraphicFramePr')
            : local === 'cxnSp'
              ? xk(obj, 'nvCxnSpPr')
              : xk(obj, 'nvContentPartPr')
  const c = xk(nv, 'cNvPr')
  const spPr = xk(obj, local === 'grpSp' ? 'grpSpPr' : 'spPr')
  const xfrm = local === 'graphicFrame' ? xk(obj, 'xfrm') : ak(spPr, 'xfrm')
  const base: DrawingObject = {
    id: c?.getAttribute('id') ?? '',
    kind: 'other',
    name: c?.getAttribute('name') ?? '',
    alt: c?.getAttribute('descr') ?? '',
    hidden: c?.getAttribute('hidden') === '1' || c?.getAttribute('hidden') === 'true',
    rotation: num(xfrm, 'rot') / 60_000,
    flipH: xfrm?.getAttribute('flipH') === '1',
    flipV: xfrm?.getAttribute('flipV') === '1',
  }
  if (local === 'pic') {
    const blipFill = xk(obj, 'blipFill')
    const blip = ak(blipFill, 'blip')
    const rid = blip?.getAttributeNS(NS_R, 'embed') || blip?.getAttributeNS(NS_R, 'link') || ''
    const part = ctx.rels.get(rid) ?? null
    const src = ak(blipFill, 'srcRect')
    return {
      ...base,
      kind: 'picture',
      image: part && ctx.wb.pkg.has(part) ? { part, contentType: ctx.wb.pkg.contentType(part) } : null,
      crop: {
        l: num(src, 'l') / 100_000,
        t: num(src, 't') / 100_000,
        r: num(src, 'r') / 100_000,
        b: num(src, 'b') / 100_000,
      },
    }
  }
  if (local === 'sp' || local === 'cxnSp') {
    const sc = styleColors(obj, ctx.theme)
    const txBody = xk(obj, 'txBody')
    const isText = xk(nv, 'cNvSpPr')?.getAttribute('txBox') === '1'
    return {
      ...base,
      kind: local === 'cxnSp' ? 'connector' : isText ? 'textbox' : 'shape',
      geometry: ak(spPr, 'prstGeom')?.getAttribute('prst') ?? null,
      fill: local === 'cxnSp' ? null : readFill(spPr, ctx.theme, sc.fill, sc.hasFill),
      line: readLine(spPr, ctx.theme, sc.line, sc.hasLine),
      text: readText(txBody),
      textColor: firstRunColor(txBody, ctx.theme) ?? sc.font,
    }
  }
  if (local === 'graphicFrame') {
    const data = ak(ak(obj, 'graphic'), 'graphicData')
    const uri = data?.getAttribute('uri') ?? null
    const chart = data ? kid(data, 'chart', NS_C) : null
    const rid = chart?.getAttributeNS(NS_R, 'id') ?? ''
    return {
      ...base,
      kind: chart ? 'chart' : 'frame',
      chartPart: chart ? (ctx.rels.get(rid) ?? null) : null,
      graphicUri: uri,
    }
  }
  if (local === 'grpSp') return { ...base, kind: 'group' }
  return base
}

/** A group's children with their boxes: the child coordinate space (chOff/chExt) mapped onto the group's box. */
function readGroup(grp: Element, box: Box, ctx: ReadCtx): Array<DrawingObject & { box: Box }> {
  const x = ak(xk(grp, 'grpSpPr'), 'xfrm')
  const chOff = ak(x, 'chOff')
  const chExt = ak(x, 'chExt')
  const sx = num(chExt, 'cx') ? (box.w * EMU_PER_PX) / num(chExt, 'cx') : 1
  const sy = num(chExt, 'cy') ? (box.h * EMU_PER_PX) / num(chExt, 'cy') : 1
  const out: Array<DrawingObject & { box: Box }> = []
  for (const child of kids(grp, undefined)) {
    if (child.namespaceURI !== NS_XDR || !(OBJECTS as readonly string[]).includes(child.localName!)) continue
    const model = readObject(child, ctx)
    const cx = child.localName === 'grpSp' ? ak(xk(child, 'grpSpPr'), 'xfrm') : child.localName === 'graphicFrame' ? xk(child, 'xfrm') : ak(xk(child, 'spPr'), 'xfrm')
    const o = ak(cx, 'off')
    const e = ak(cx, 'ext')
    const cbox = {
      x: box.x + ((num(o, 'x') - num(chOff, 'x')) * sx) / EMU_PER_PX,
      y: box.y + ((num(o, 'y') - num(chOff, 'y')) * sy) / EMU_PER_PX,
      w: (num(e, 'cx') * sx) / EMU_PER_PX,
      h: (num(e, 'cy') * sy) / EMU_PER_PX,
    }
    if (model.kind === 'group') model.children = readGroup(child, cbox, ctx)
    out.push({ ...model, box: cbox })
  }
  return out
}

/** Every anchored object of a sheet's drawing (empty: the sheet has none), with group children placed by `g`. */
export function readDrawing(wb: Workbook, info: SheetInfo, g?: Geometry): AnchoredObject[] {
  const part = drawingPartOf(wb, info)
  if (!part) return []
  const doc = wb.pkg.xml(part)
  const rels = new Map(wb.pkg.relationships(part).map((r) => [r.id, r.part]))
  const ctx: ReadCtx = { wb, part, theme: themeOf(wb), rels }
  const geom = g ?? sheetGeometry(wb.sheet(info.name))
  return anchorElements(doc).map((el, index) => {
    const a = innerAnchor(el)
    const obj = a ? objectOf(a) : null
    const anchor = a ? readAnchor(a) : null
    const model: DrawingObject = obj
      ? readObject(obj, ctx)
      : { id: '', kind: 'other', name: '', alt: '', hidden: false, rotation: 0, flipH: false, flipV: false }
    if (el.namespaceURI === NS_MC && model.kind !== 'chart') model.kind = 'other'
    if (model.kind === 'group' && obj && anchor) model.children = readGroup(obj, anchorBox(anchor, geom), ctx)
    return { ...model, index, anchor }
  })
}

// ---------------------------------------------------------------------------
// Writing

/** Parses an XML fragment written with the xdr/a/r prefixes and brings its elements into `doc`. */
export function fragment(doc: XMLDocument, xml: string): Element[] {
  const wrapped = `<w xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">${xml}</w>`
  const parsed = new DOMParser().parseFromString(wrapped, 'application/xml') as unknown as XMLDocument
  return kids(parsed.documentElement!, undefined).map((e) => doc.importNode(e, true) as Element)
}

export const escXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The sheet's drawing part, created (part, relationship, `<drawing r:id>`) when it has none. */
export function ensureDrawingPart(wb: Workbook, info: SheetInfo, sheetDoc: XMLDocument): string {
  const have = drawingPartOf(wb, info)
  if (have) return have
  let n = 1
  while (wb.pkg.has(`/xl/drawings/drawing${n}.xml`)) n++
  const part = `/xl/drawings/drawing${n}.xml`
  wb.write(
    part,
    strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}"/>`,
    ),
    CT_DRAWING,
  )
  wb.touch(relsPartOf(info.part))
  const id = wb.pkg.addRelationship(info.part, REL_DRAWING, relativeTarget(info.part, part))
  setRelElement(sheetDoc, 'drawing', id)
  return part
}

/** Writes `<local r:id="…">` into the worksheet where CT_Worksheet wants it (drawing, legacyDrawing). */
export function setRelElement(sheetDoc: XMLDocument, local: string, id: string) {
  const root = sheetDoc.documentElement!
  const prefix = root.lookupPrefix(NS_R) ?? 'r'
  if (!root.lookupPrefix(NS_R)) root.setAttribute('xmlns:r', NS_R)
  const mainPrefix = root.prefix
  const el = sheetDoc.createElementNS(root.namespaceURI, mainPrefix ? `${mainPrefix}:${local}` : local)
  el.setAttributeNS(NS_R, `${prefix}:id`, id)
  insertInOrder(root, el, WORKSHEET_ORDER)
}

/** A new object id for the drawing: one above every `cNvPr id` in it. */
export function nextObjectId(doc: XMLDocument): number {
  let max = 1
  const list = doc.getElementsByTagNameNS(NS_XDR, 'cNvPr')
  for (let i = 0; i < list.length; i++) max = Math.max(max, Number(list[i]!.getAttribute('id')) || 0)
  return max + 1
}

/** The anchor element whose object has id `id`; throws when the drawing has none (or several). */
export function findAnchor(doc: XMLDocument, id: string): Element {
  const hits = anchorElements(doc).filter((el) => {
    const a = innerAnchor(el)
    const obj = a ? objectOf(a) : null
    return obj && objectCNvPr(obj)?.getAttribute('id') === id
  })
  if (hits.length === 0) throw new XlsxError(`This sheet has no picture or shape with id ${id}.`)
  if (hits.length > 1) throw new XlsxError(`Several objects on this sheet have id ${id}; edit them in Excel.`)
  return hits[0]!
}

export function objectCNvPr(obj: Element): Element | null {
  for (const nv of kids(obj, undefined)) if (nv.localName?.startsWith('nv')) return xk(nv, 'cNvPr')
  return null
}

export { innerAnchor, objectOf }

function writeMarker(el: Element, m: Marker) {
  for (const [local, v] of [['col', m.col], ['colOff', m.colOff], ['row', m.row], ['rowOff', m.rowOff]] as const) {
    const k = xk(el, local)
    if (k) k.textContent = String(Math.max(0, Math.round(v)))
  }
}

/** Writes an anchor's position (markers, ext, pos) and the object's own transform to match. */
export function writeAnchor(anchorEl: Element, a: Anchor, box: Box) {
  if (a.type !== 'absolute') writeMarker(xk(anchorEl, 'from')!, a.from)
  if (a.type === 'twoCell') writeMarker(xk(anchorEl, 'to')!, a.to)
  if (a.type !== 'twoCell') {
    const ext = xk(anchorEl, 'ext')
    ext?.setAttribute('cx', String(a.ext.cx))
    ext?.setAttribute('cy', String(a.ext.cy))
  }
  if (a.type === 'absolute') {
    const pos = xk(anchorEl, 'pos')
    pos?.setAttribute('x', String(a.pos.x))
    pos?.setAttribute('y', String(a.pos.y))
  }
  const obj = objectOf(anchorEl)
  if (!obj) return
  const xfrm =
    obj.localName === 'graphicFrame'
      ? xk(obj, 'xfrm')
      : ak(xk(obj, obj.localName === 'grpSp' ? 'grpSpPr' : 'spPr'), 'xfrm')
  const off = ak(xfrm, 'off')
  const ext = ak(xfrm, 'ext')
  off?.setAttribute('x', String(Math.round(box.x * EMU_PER_PX)))
  off?.setAttribute('y', String(Math.round(box.y * EMU_PER_PX)))
  ext?.setAttribute('cx', String(Math.round(box.w * EMU_PER_PX)))
  ext?.setAttribute('cy', String(Math.round(box.h * EMU_PER_PX)))
}

/**
 * Rows or columns inserted/deleted on the sheet: anchors follow the cells as
 * Excel moves them. "Move and size with cells" (two-cell) markers move on
 * their own, so an object grows over inserted lines and shrinks over deleted
 * ones (down to nothing when all its lines go); "move but don't size"
 * (one-cell) objects keep their span; absolute ones stay. Returns whether
 * any anchor changed.
 */
export function shiftDrawing(doc: XMLDocument, axis: 'row' | 'col', at: number, count: number, insert: boolean): boolean {
  const end = at + count - 1
  const move = (i: number) => (insert ? (i >= at ? i + count : i) : i > end ? i - count : i >= at ? at : i)
  let changed = false
  const markerEls = (el: Element) => {
    const out: Element[] = []
    const list = el.getElementsByTagNameNS(NS_XDR, 'from')
    for (let i = 0; i < list.length; i++) out.push(list[i]!)
    return out
  }
  const lineOf = (m: Element) => xk(m, axis)!
  const offOf = (m: Element) => xk(m, axis === 'row' ? 'rowOff' : 'colOff')!
  const shiftMarker = (m: Element, by: number | null) => {
    const line = lineOf(m)
    const i = Number(line.textContent)
    const next = by === null ? move(i) : i + by
    const inDeleted = !insert && i >= at && i <= end && by === null
    if (next !== i) {
      line.textContent = String(Math.max(0, next))
      changed = true
    }
    if (inDeleted && offOf(m).textContent !== '0') {
      offOf(m).textContent = '0'
      changed = true
    }
    return next - i
  }
  for (const wrapper of anchorElements(doc)) {
    // Markup Compatibility wrappers: every branch's anchor moves the same way.
    const anchors = wrapper.namespaceURI === NS_MC ? [...markerEls(wrapper)].map((f) => f.parentNode as Element) : [wrapper]
    for (const a of anchors) {
      if (a.localName === 'absoluteAnchor') continue
      const editAs = a.getAttribute('editAs')
      if (a.localName === 'twoCellAnchor' && editAs === 'absolute') continue
      const from = xk(a, 'from')
      const to = xk(a, 'to')
      if (!from) continue
      const delta = shiftMarker(from, null)
      if (to) shiftMarker(to, a.localName === 'twoCellAnchor' && editAs === 'oneCell' ? delta : null)
    }
  }
  return changed
}

/**
 * After an object went: relationships of `part` nothing in it uses any more
 * are removed, and their target parts too when nothing else in the package
 * points at them (an image two pictures share stays while one uses it).
 */
export function dropUnusedRels(wb: Workbook, part: string) {
  const doc = wb.pkg.xml(part)
  const used = new Set<string>()
  const walk = (el: Element) => {
    for (let i = 0; i < el.attributes.length; i++) {
      const at = el.attributes[i]!
      if (at.namespaceURI === NS_R) used.add(at.value)
    }
    for (const k of kids(el, undefined)) walk(k)
  }
  walk(doc.documentElement!)
  const relsPart = relsPartOf(part)
  if (!wb.pkg.has(relsPart)) return
  const unused = wb.pkg.relationships(part).filter((r) => !used.has(r.id))
  if (unused.length === 0) return
  const rels = wb.edit(relsPart)
  for (const el of kids(rels.documentElement!, 'Relationship', 'http://schemas.openxmlformats.org/package/2006/relationships'))
    if (unused.some((u) => u.id === el.getAttribute('Id'))) rels.documentElement!.removeChild(el)
  for (const r of unused) if (r.part) dropIfOrphan(wb, r.part, new Set([relsPart]))
}

/** Removes `part` (and what only it reaches) when no relationship in the package targets it. */
function dropIfOrphan(wb: Workbook, part: string, editedRels: Set<string>) {
  if (!wb.pkg.has(part)) return
  for (const p of wb.pkg.partNames()) {
    if (!p.endsWith('.rels')) continue
    const source = sourceOfRels(p)
    if (source === null) continue
    if (wb.pkg.relationships(source).some((r) => r.part?.toLowerCase() === part.toLowerCase())) return
  }
  const targets = wb.pkg.relationships(part).flatMap((r) => (r.part ? [r.part] : []))
  wb.remove(part)
  wb.remove(relsPartOf(part))
  for (const t of targets) dropIfOrphan(wb, t, editedRels)
}

/** "/xl/drawings/_rels/drawing1.xml.rels" → "/xl/drawings/drawing1.xml"; "/_rels/.rels" → "/". */
function sourceOfRels(rels: string): string | null {
  const m = /^(.*)\/_rels\/(.*)\.rels$/.exec(rels)
  if (!m) return null
  return m[2] === '' ? '/' : `${m[1]}/${m[2]}`
}

/** Whether an anchor sits inside one row (and so moves with it in a sort): its row, else null. */
export function oneRowOf(anchorEl: Element): number | null {
  if (anchorEl.localName === 'absoluteAnchor') return null
  if (anchorEl.localName === 'twoCellAnchor' && anchorEl.getAttribute('editAs') === 'absolute') return null
  const from = readMarker(xk(anchorEl, 'from'))
  if (anchorEl.localName === 'oneCellAnchor') return from.row
  const to = readMarker(xk(anchorEl, 'to'))
  return to.row === from.row || (to.row === from.row + 1 && to.rowOff === 0) ? from.row : null
}

/** Whether the anchor holds a chart (a graphic frame with `c:chart`). */
export function isChartAnchor(anchorEl: Element): boolean {
  const obj = objectOf(anchorEl)
  if (!obj || obj.localName !== 'graphicFrame') return false
  return obj.getElementsByTagNameNS(NS_C, 'chart').length > 0
}

/**
 * The row an anchor moves with in a sort, or null when it stays: a chart
 * moves with the row it starts in (keeping its height, as the charts stream
 * decided), any other object only when it sits inside one row.
 */
export function sortRowOf(anchorEl: Element): number | null {
  if (!isChartAnchor(anchorEl)) return oneRowOf(anchorEl)
  if (anchorEl.localName === 'absoluteAnchor') return null
  if (anchorEl.localName === 'twoCellAnchor' && anchorEl.getAttribute('editAs') === 'absolute') return null
  return readMarker(xk(anchorEl, 'from')).row
}

/** The anchor's first column (null: absolute). */
export function fromColOf(anchorEl: Element): number | null {
  const f = xk(anchorEl, 'from')
  return f ? readMarker(f).col : null
}

/**
 * Sorted rows (`dest`: old row -> new row, columns left..right): objects that
 * sit inside one row of the sorted cells move with it, as Excel moves them.
 * Returns whether any moved.
 */
export function sortDrawing(doc: XMLDocument, dest: Map<number, number>, left: number, right: number): boolean {
  let changed = false
  for (const el of anchorElements(doc)) {
    if (el.namespaceURI !== NS_XDR) continue
    const row = sortRowOf(el)
    const col = fromColOf(el)
    if (row === null || col === null || col < left || col > right) continue
    const to = dest.get(row)
    if (to === undefined) continue
    for (const local of ['from', 'to']) {
      const r = xk(xk(el, local), 'row')
      if (r) r.textContent = String(Number(r.textContent) + to - row)
    }
    changed = true
  }
  return changed
}
