import type { OpResult } from './ops'
import { relsPartOf } from '../ooxml/package'
import {
  anchorBox,
  anchorElements,
  anchorFor,
  drawingPartOf,
  dropUnusedRels,
  ensureDrawingPart,
  escXml,
  findAnchor,
  fragment,
  makeGeometry,
  markerAt,
  nextObjectId,
  NS_XDR,
  objectCNvPr,
  objectOf,
  readAnchor,
  readDrawing,
  REL_IMAGE,
  sheetGeometry,
  writeAnchor,
  EMU_PER_PX,
  type Box,
} from './drawing'
import { imageInfo } from './image-info'
import { normalizeRefs } from './sheet-xml'
import { relativeTarget, XlsxError, type SheetInfo, type Workbook } from './workbook'
import { kid, kids, NS_A, NS_R } from './xml'

/**
 * Pictures, shapes and text boxes as sheet operations (the grid and the
 * drive.sheet_picture_* / drive.sheet_shape_* tools make the same ones):
 * insert, move and resize, alternative text and name, a shape's text, fill
 * and outline, delete. Each changes only the sheet's drawing part (and, for
 * a new drawing or picture, the relationships, the media part and the sheet's
 * `<drawing>` element); every other anchor stays exactly as written.
 */

/** The shapes the editor inserts (DrawingML preset geometries, §20.1.10.56). */
export const SHAPE_GEOMETRIES = [
  'rect',
  'roundRect',
  'ellipse',
  'triangle',
  'diamond',
  'rightArrow',
  'leftArrow',
  'upArrow',
  'downArrow',
  'line',
  'arrow',
] as const
export type ShapeGeometry = (typeof SHAPE_GEOMETRIES)[number]

export type DrawingOp =
  | {
      op: 'insert_picture'
      sheet: string
      /** PNG, JPEG, GIF or BMP bytes. */
      image: Uint8Array
      /** Top-left corner in sheet pixels; width/height default to the picture's own size (at most 640 px wide). */
      x: number
      y: number
      width?: number
      height?: number
      name?: string
      alt?: string
    }
  | {
      op: 'insert_shape'
      sheet: string
      geometry: ShapeGeometry
      /** A text box (Excel's Insert ▸ Text Box) rather than a shape. */
      textbox?: boolean
      x: number
      y: number
      width: number
      height: number
      text?: string
      fill?: string | null
      line?: string | null
      name?: string
      alt?: string
    }
  | {
      op: 'update_drawing'
      sheet: string
      id: string
      /** New place and size in sheet pixels. */
      box?: Box
      name?: string
      alt?: string
      /** Degrees clockwise. */
      rotation?: number
      /** Shapes and text boxes only. */
      text?: string
      fill?: string | null
      line?: string | null
    }
  | { op: 'delete_drawing'; sheet: string; id: string }

export const DRAWING_OPS = ['insert_picture', 'insert_shape', 'update_drawing', 'delete_drawing'] as const

const COLOR = /^#[0-9A-Fa-f]{6}$/
const MAX_NEW_WIDTH = 640

function checkColor(c: string | null | undefined, what: string) {
  if (c !== undefined && c !== null && !COLOR.test(c)) throw new XlsxError(`${what} must be a colour like #4472C4.`)
}

function checkBox(b: { x: number; y: number; w: number; h: number }) {
  for (const v of [b.x, b.y, b.w, b.h])
    if (!Number.isFinite(v)) throw new XlsxError('A position or size is not a number.')
  if (b.x < 0 || b.y < 0) throw new XlsxError('A picture or shape can’t start left of column A or above row 1.')
  if (b.w < 1 || b.h < 0 || b.w > 20_000 || b.h > 20_000)
    throw new XlsxError('A picture or shape must be 1 to 20000 pixels wide and at most 20000 high.')
}

const marker = (tag: 'from' | 'to', m: { col: number; colOff: number; row: number; rowOff: number }) =>
  `<xdr:${tag}><xdr:col>${m.col}</xdr:col><xdr:colOff>${m.colOff}</xdr:colOff><xdr:row>${m.row}</xdr:row><xdr:rowOff>${m.rowOff}</xdr:rowOff></xdr:${tag}>`

const xfrm = (b: Box) =>
  `<a:xfrm><a:off x="${Math.round(b.x * EMU_PER_PX)}" y="${Math.round(b.y * EMU_PER_PX)}"/><a:ext cx="${Math.round(b.w * EMU_PER_PX)}" cy="${Math.round(b.h * EMU_PER_PX)}"/></a:xfrm>`

const solid = (hex: string) => `<a:solidFill><a:srgbClr val="${hex.slice(1).toUpperCase()}"/></a:solidFill>`

function paragraphs(text: string, color: string | null): string {
  const rPr = `<a:rPr lang="en-US" sz="1100">${color ? solid(color) : ''}</a:rPr>`
  return text
    .split('\n')
    .map((p) => (p === '' ? `<a:p><a:endParaRPr lang="en-US" sz="1100"/></a:p>` : `<a:p><a:r>${rPr}<a:t>${escXml(p)}</a:t></a:r></a:p>`))
    .join('')
}

function sheetDoc(wb: Workbook, info: SheetInfo): XMLDocument {
  const doc = wb.edit(info.part)
  normalizeRefs(doc)
  return doc
}

/** Runs a drawing operation inside the open transaction. */
export function runDrawingOp(wb: Workbook, op: DrawingOp): OpResult {
  const info = wb.requireWorksheet(op.sheet)
  const g = sheetGeometry(wb.sheet(info.name))
  if (op.op === 'insert_picture' || op.op === 'insert_shape') {
    let w: number
    let h: number
    let mediaRel = ''
    if (op.op === 'insert_picture') {
      const img = imageInfo(op.image)
      if (img.width < 1 || img.height < 1) throw new XlsxError('This picture has no size.')
      const scale = op.width === undefined && img.width > MAX_NEW_WIDTH ? MAX_NEW_WIDTH / img.width : 1
      w = op.width ?? img.width * scale
      h = op.height ?? (op.width !== undefined ? (op.width * img.height) / img.width : img.height * scale)
      checkBox({ x: op.x, y: op.y, w, h })
      const part = drawingPartOf(wb, info) ?? ensureDrawingPart(wb, info, sheetDoc(wb, info))
      let n = 1
      while (wb.pkg.has(`/xl/media/image${n}.${img.ext}`)) n++
      const media = `/xl/media/image${n}.${img.ext}`
      wb.write(media, op.image, img.contentType)
      wb.touch(relsPartOf(part))
      mediaRel = wb.pkg.addRelationship(part, REL_IMAGE, relativeTarget(part, media))
    } else {
      w = op.width
      h = op.height
      checkBox({ x: op.x, y: op.y, w, h })
      checkColor(op.fill, 'The fill')
      checkColor(op.line, 'The outline')
    }
    const box = { x: op.x, y: op.y, w, h }
    const part = drawingPartOf(wb, info) ?? ensureDrawingPart(wb, info, sheetDoc(wb, info))
    const ddoc = wb.edit(part)
    const root = ddoc.documentElement!
    if (!root.lookupPrefix(NS_R)) root.setAttribute('xmlns:r', NS_R)
    if (!root.lookupPrefix(NS_A)) root.setAttribute('xmlns:a', NS_A)
    const id = nextObjectId(ddoc)
    const from = markerAt(g, box.x, box.y)
    const to = markerAt(g, box.x + box.w, box.y + box.h)
    let xml: string
    if (op.op === 'insert_picture') {
      const name = escXml(op.name ?? `Picture ${id - 1}`)
      // Excel's default for an inserted picture: move with cells, don't size (editAs="oneCell").
      xml = `<xdr:twoCellAnchor editAs="oneCell">${marker('from', from)}${marker('to', to)}<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="${name}"${op.alt ? ` descr="${escXml(op.alt)}"` : ''}/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${mediaRel}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`
    } else {
      const isLine = op.geometry === 'line' || op.geometry === 'arrow'
      const textbox = !!op.textbox
      const fill = isLine ? null : op.fill === undefined ? (textbox ? '#FFFFFF' : '#4472C4') : op.fill
      const line = op.line === undefined ? (textbox ? '#BFBFBF' : isLine ? '#4472C4' : '#2F528F') : op.line
      const textColor = textbox || !fill ? '#000000' : '#FFFFFF'
      const prst = op.geometry === 'arrow' ? 'line' : op.geometry
      const label = textbox ? 'TextBox' : isLine ? 'Straight Connector' : 'Shape'
      const name = escXml(op.name ?? `${label} ${id - 1}`)
      const ln = line
        ? `<a:ln w="${isLine ? 19050 : 12700}">${solid(line)}${op.geometry === 'arrow' ? '<a:tailEnd type="triangle"/>' : ''}</a:ln>`
        : '<a:ln><a:noFill/></a:ln>'
      const body = isLine
        ? ''
        : `<xdr:txBody><a:bodyPr vertOverflow="clip" horzOverflow="clip" wrap="square" rtlCol="0" anchor="${textbox ? 't' : 'ctr'}"/><a:lstStyle/>${paragraphs(op.text ?? '', textColor)}</xdr:txBody>`
      xml = `<xdr:twoCellAnchor>${marker('from', from)}${marker('to', to)}<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${id}" name="${name}"${op.alt ? ` descr="${escXml(op.alt)}"` : ''}/><xdr:cNvSpPr${textbox ? ' txBox="1"' : ''}/></xdr:nvSpPr><xdr:spPr>${xfrm(box)}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${fill ? solid(fill) : '<a:noFill/>'}${ln}</xdr:spPr>${body}</xdr:sp><xdr:clientData/></xdr:twoCellAnchor>`
    }
    for (const el of fragment(ddoc, xml)) root.appendChild(el)
    return { sheets: [info.name], created: String(id) }
  }

  const objects = readDrawing(wb, info, g)
  const target = objects.find((o) => o.id === op.id)
  if (!target) throw new XlsxError(`This sheet has no picture or shape with id ${op.id}.`)
  const part = drawingPartOf(wb, info)!
  const ddoc = wb.edit(part)
  const anchorEl = findAnchor(ddoc, op.id)
  if (op.op === 'delete_drawing') {
    anchorEl.parentNode!.removeChild(anchorEl)
    dropUnusedRels(wb, part)
    if (anchorElements(ddoc).length === 0) {
      const sdoc = sheetDoc(wb, info)
      const rel = wb.pkg.relationships(info.part).find((r) => r.part === part)
      if (rel) {
        const rels = wb.edit(relsPartOf(info.part))
        for (const el of kids(
          rels.documentElement!,
          'Relationship',
          'http://schemas.openxmlformats.org/package/2006/relationships',
        ))
          if (el.getAttribute('Id') === rel.id) rels.documentElement!.removeChild(el)
        const el = kid(sdoc.documentElement!, 'drawing')
        if (el && el.getAttributeNS(NS_R, 'id') === rel.id) sdoc.documentElement!.removeChild(el)
      }
      wb.remove(part)
      wb.remove(relsPartOf(part))
    }
    return { sheets: [info.name] }
  }
  const obj = objectOf(anchorEl)
  if (!obj || anchorEl.namespaceURI !== NS_XDR)
    throw new XlsxError(`The object ${op.id} is written in a form this editor keeps but does not change; edit it in Excel.`)
  if (op.box) {
    checkBox(op.box)
    const a = readAnchor(anchorEl)
    if (!a) throw new XlsxError(`The object ${op.id} has no position this editor can change.`)
    writeAnchor(anchorEl, anchorFor(a, op.box, g), op.box)
  }
  const c = objectCNvPr(obj)
  if (op.name !== undefined) {
    if (op.name.trim() === '') throw new XlsxError('A picture or shape needs a name.')
    c?.setAttribute('name', op.name.trim())
  }
  if (op.alt !== undefined) {
    if (op.alt === '') c?.removeAttribute('descr')
    else c?.setAttribute('descr', op.alt)
  }
  if (op.rotation !== undefined) {
    if (!Number.isFinite(op.rotation)) throw new XlsxError('The rotation is not a number.')
    const x = transformOf(obj, ddoc)
    const deg = ((op.rotation % 360) + 360) % 360
    if (deg === 0) x.removeAttribute('rot')
    else x.setAttribute('rot', String(Math.round(deg * 60_000)))
  }
  const shapeOnly = op.text !== undefined || op.fill !== undefined || op.line !== undefined
  if (shapeOnly) {
    if (obj.localName !== 'sp' && !(obj.localName === 'cxnSp' && op.text === undefined && op.fill === undefined))
      throw new XlsxError(`The object ${op.id} is not a shape or text box: only those have text, fill and outline here.`)
    checkColor(op.fill, 'The fill')
    checkColor(op.line, 'The outline')
    const spPr = kid(obj, 'spPr', NS_XDR)!
    if (op.fill !== undefined) setFill(spPr, op.fill)
    if (op.line !== undefined) setLine(spPr, op.line)
    if (op.text !== undefined) setShapeText(obj, op.text)
  }
  return { sheets: [info.name] }
}

/** The object's `a:xfrm` (created from its anchor's box when missing). */
function transformOf(obj: Element, doc: XMLDocument): Element {
  const spPr = kid(obj, obj.localName === 'grpSp' ? 'grpSpPr' : 'spPr', NS_XDR)
  const host = obj.localName === 'graphicFrame' ? obj : spPr
  if (!host) throw new XlsxError('This object can’t be rotated here.')
  const have = obj.localName === 'graphicFrame' ? kid(obj, 'xfrm', NS_XDR) : kid(host, 'xfrm', NS_A)
  if (have) return have
  const [x] = fragment(doc, '<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>')
  host.insertBefore(x!, host.firstChild)
  return x!
}

const FILLS = ['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill']

function setFill(spPr: Element, hex: string | null) {
  const doc = spPr.ownerDocument!
  for (const k of kids(spPr, undefined)) if (k.namespaceURI === NS_A && FILLS.includes(k.localName!)) spPr.removeChild(k)
  const [el] = fragment(doc, hex ? solid(hex) : '<a:noFill/>')
  // CT_ShapeProperties: xfrm, geometry, then the fill.
  const after = kids(spPr, undefined).find(
    (k) => k.namespaceURI === NS_A && !['xfrm', 'custGeom', 'prstGeom'].includes(k.localName!),
  )
  spPr.insertBefore(el!, after ?? null)
}

function setLine(spPr: Element, hex: string | null) {
  const doc = spPr.ownerDocument!
  let ln = kid(spPr, 'ln', NS_A)
  if (!ln) {
    ;[ln] = fragment(doc, '<a:ln w="12700"/>') as [Element]
    const after = kids(spPr, undefined).find(
      (k) => k.namespaceURI === NS_A && !['xfrm', 'custGeom', 'prstGeom', ...FILLS].includes(k.localName!),
    )
    spPr.insertBefore(ln, after ?? null)
  }
  for (const k of kids(ln, undefined)) if (k.namespaceURI === NS_A && ['noFill', 'solidFill', 'gradFill', 'pattFill'].includes(k.localName!)) ln.removeChild(k)
  const [fill] = fragment(doc, hex ? solid(hex) : '<a:noFill/>')
  ln.insertBefore(fill!, ln.firstChild)
}

/** Replaces a shape's text, keeping its body properties and the first run's formatting. */
function setShapeText(sp: Element, text: string) {
  const doc = sp.ownerDocument!
  let body = kid(sp, 'txBody', NS_XDR)
  if (!body) {
    ;[body] = fragment(doc, '<xdr:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/></xdr:txBody>') as [Element]
    sp.appendChild(body)
  }
  const firstRPr = body.getElementsByTagNameNS(NS_A, 'rPr')[0]
  const pPr = kid(kids(body, 'p', NS_A)[0] ?? body, 'pPr', NS_A)
  for (const p of kids(body, 'p', NS_A)) body.removeChild(p)
  for (const line of text.split('\n')) {
    const [p] = fragment(doc, '<a:p/>') as [Element]
    if (pPr) p.appendChild(pPr.cloneNode(true))
    if (line === '') {
      const [end] = fragment(doc, '<a:endParaRPr lang="en-US"/>')
      p.appendChild(end!)
    } else {
      const [r] = fragment(doc, `<a:r><a:t>${escXml(line)}</a:t></a:r>`) as [Element]
      if (firstRPr) r.insertBefore(firstRPr.cloneNode(true), r.firstChild)
      p.appendChild(r)
    }
    body.appendChild(p)
  }
}

/** Sheet pixels of a cell's top-left corner (the tools place objects at cells). */
export function cellOrigin(wb: Workbook, sheet: string, row: number, col: number): { x: number; y: number } {
  const g = sheetGeometry(wb.sheet(sheet))
  return { x: g.colLeft(col), y: g.rowTop(row) }
}

/** The box of an object as the grid draws it (tools report it in cells and pixels). */
export function boxOf(wb: Workbook, sheet: string, id: string): Box {
  const info = wb.requireWorksheet(sheet)
  const g = sheetGeometry(wb.sheet(info.name))
  const o = readDrawing(wb, info, g).find((x) => x.id === id)
  if (!o?.anchor) throw new XlsxError(`This sheet has no picture or shape with id ${id}.`)
  return anchorBox(o.anchor, g)
}

export { makeGeometry }
