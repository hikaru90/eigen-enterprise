import type { PDFDocument, PDFFont, PDFObject, PDFPage } from 'pdf-lib'
/**
 * Annotations in the file (plan/phase-office-files.md P3; ISO 32000-2 §12.5):
 * read every page's /Annots into the model of ./annotate-model.ts, and write
 * staged edits back as real annotation dictionaries with appearance streams
 * (/AP /N), so every other PDF reader shows them as drawn here. Runs the
 * same in the browser and in Node (pdf-lib, MIT).
 *
 * Edits keep what they don't change: a moved annotation keeps its own
 * appearance (the stream follows /Rect), only the keys an edit names are
 * set, and page content streams are never touched.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  StandardFonts,
} from 'pdf-lib/dist/pdf-lib.esm.js'
import { randomUuid } from '$lib/random-uuid'
import {
  ANNOTATION_KINDS,
  appearanceOf,
  checkShape,
  type AnnotationEdit,
  type AnnotationKind,
  type AnnotationShape,
  type EditContext,
  type LineEnding,
  type Measure,
  moveRect,
  type NewAnnotation,
  normRect,
  parsePdfDate,
  pdfDate,
  PdfEditError,
  type PdfAnnotation,
  type Primitive,
  type Rect,
  rectOf,
  REVIEW_STATES,
  type ReviewMark,
  type ReviewState,
  type Rgb,
} from './annotate-model'

const N = (name: string) => PDFName.of(name)

/** Annotation flags (§12.5.3). */
const F_HIDDEN = 2
const F_PRINT = 4
const F_NO_ZOOM = 8
const F_NO_ROTATE = 16

/** The id pdf.js gives the annotation object (its Ref.toString()). */
export function idOfRef(ref: PDFRef): string {
  return ref.generationNumber === 0
    ? `${ref.objectNumber}R`
    : `${ref.objectNumber}R${ref.generationNumber}`
}

// ---------------------------------------------------------------------------
// Reading

type Entry = { ref: PDFRef | null; dict: PDFDict; page: number; index: number }

function entriesOf(doc: PDFDocument): Entry[] {
  const out: Entry[] = []
  doc.getPages().forEach((page, pi) => {
    const annots = page.node.Annots()
    if (!annots) return
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i)
      const dict = doc.context.lookupMaybe(raw, PDFDict)
      if (!dict) continue
      out.push({ ref: raw instanceof PDFRef ? raw : null, dict, page: pi, index: i })
    }
  })
  return out
}

const idOfEntry = (e: Entry) => (e.ref ? idOfRef(e.ref) : `p${e.page}a${e.index}`)

function text(dict: PDFDict, key: string): string | null {
  const v = dict.lookup(N(key))
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null
}

function name(dict: PDFDict, key: string): string | null {
  const v = dict.lookup(N(key))
  return v instanceof PDFName ? v.decodeText() : null
}

/** /StateModel and /State are text strings (§12.5.6.3); some writers use names. */
function textOrName(dict: PDFDict, key: string): string | null {
  return text(dict, key) ?? name(dict, key)
}

function num(dict: PDFDict, key: string): number | null {
  const v = dict.lookup(N(key))
  return v instanceof PDFNumber ? v.asNumber() : null
}

function nums(doc: PDFDocument, v: PDFObject | undefined): number[] | null {
  const arr = v ? doc.context.lookupMaybe(v, PDFArray) : undefined
  if (!arr) return null
  const out: number[] = []
  for (let i = 0; i < arr.size(); i++) {
    const n = doc.context.lookup(arr.get(i))
    if (!(n instanceof PDFNumber)) return null
    out.push(n.asNumber())
  }
  return out
}

/** A colour array (§12.5.2 /C, /IC): none, gray, RGB or CMYK. */
function colourOf(doc: PDFDocument, dict: PDFDict, key: string): Rgb | null {
  const c = nums(doc, dict.get(N(key)))
  if (!c || c.length === 0) return null
  if (c.length === 1) return [c[0]!, c[0]!, c[0]!]
  if (c.length === 3) return [c[0]!, c[1]!, c[2]!]
  if (c.length === 4) {
    const [cy, m, y, k] = c as [number, number, number, number]
    return [(1 - cy) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
  }
  return null
}

function borderWidth(doc: PDFDocument, dict: PDFDict): number {
  const bs = dict.lookupMaybe(N('BS'), PDFDict)
  const w = bs ? num(bs, 'W') : null
  if (w !== null) return w
  const border = nums(doc, dict.get(N('Border')))
  return border && border.length >= 3 ? border[2]! : 1
}

function lineEnding(v: string | undefined): LineEnding {
  return v === 'OpenArrow' || v === 'ClosedArrow' ? v : 'None'
}

function shapeOf(
  doc: PDFDocument,
  dict: PDFDict,
  kind: AnnotationKind,
  rect: Rect,
): AnnotationShape {
  switch (kind) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const q = nums(doc, dict.get(N('QuadPoints')))
      const quads: number[][] = []
      if (q && q.length >= 8)
        for (let i = 0; i + 8 <= q.length; i += 8) quads.push(q.slice(i, i + 8))
      else {
        const [x1, y1, x2, y2] = rect
        quads.push([x1, y2, x2, y2, x1, y1, x2, y1])
      }
      return { kind, quads }
    }
    case 'Text':
      return { kind, at: [rect[0], rect[3]] }
    case 'Ink': {
      const list = dict.lookupMaybe(N('InkList'), PDFArray)
      const paths: number[][] = []
      for (let i = 0; list && i < list.size(); i++) {
        const p = nums(doc, list.get(i))
        if (p && p.length >= 2) paths.push(p)
      }
      return { kind, paths, width: borderWidth(doc, dict) }
    }
    case 'FreeText': {
      const da = text(dict, 'DA') ?? ''
      const size = /(\d+(?:\.\d+)?)\s+Tf/.exec(da)
      return { kind, rect, fontSize: size ? Number(size[1]) || 12 : 12 }
    }
    case 'Square':
    case 'Circle':
      return { kind, rect, width: borderWidth(doc, dict), fill: colourOf(doc, dict, 'IC') }
    case 'Line': {
      const l = nums(doc, dict.get(N('L')))
      const le = dict.lookupMaybe(N('LE'), PDFArray)
      const end = (i: number) => {
        const v = le ? doc.context.lookup(le.get(i)) : undefined
        return lineEnding(v instanceof PDFName ? v.decodeText() : undefined)
      }
      return {
        kind,
        line:
          l && l.length === 4
            ? (l as [number, number, number, number])
            : [rect[0], rect[1], rect[2], rect[3]],
        width: borderWidth(doc, dict),
        ends: [end(0), end(1)],
      }
    }
  }
}

const isKind = (s: string): s is AnnotationKind =>
  (ANNOTATION_KINDS as readonly string[]).includes(s)
const isReview = (s: string): s is ReviewState => (REVIEW_STATES as readonly string[]).includes(s)
const NOT_LISTED = new Set(['Popup', 'Widget'])

/**
 * Every annotation on every page except popups (part of their note) and form
 * widgets (./forms.ts lists those). State annotations (§12.5.6.3) are folded
 * into the annotation they mark: `review` is the latest Review state.
 */
export function readAnnotations(doc: PDFDocument): PdfAnnotation[] {
  const entries = entriesOf(doc)
  const reviews = new Map<string, ReviewMark>()
  const out: PdfAnnotation[] = []
  for (const e of entries) {
    const subtype = name(e.dict, 'Subtype') ?? 'Unknown'
    if (NOT_LISTED.has(subtype)) continue
    const irt = e.dict.get(N('IRT'))
    const inReplyTo = irt instanceof PDFRef ? idOfRef(irt) : null
    const modified = parsePdfDate(text(e.dict, 'M'))
    if (subtype === 'Text' && e.dict.has(N('StateModel'))) {
      const state = textOrName(e.dict, 'State')
      if (inReplyTo && textOrName(e.dict, 'StateModel') === 'Review' && state && isReview(state)) {
        const mark = { state, author: text(e.dict, 'T'), modified }
        const before = reviews.get(inReplyTo)
        if (!before || (before.modified ?? '') <= (modified ?? '')) reviews.set(inReplyTo, mark)
      }
      continue
    }
    const rectNums = nums(doc, e.dict.get(N('Rect')))
    const rect: Rect = rectNums && rectNums.length === 4 ? normRect(rectNums as Rect) : [0, 0, 0, 0]
    const kind = isKind(subtype) ? subtype : 'Other'
    const ca = num(e.dict, 'CA')
    out.push({
      id: idOfEntry(e),
      page: e.page,
      kind,
      subtype,
      rect,
      shape: kind === 'Other' ? null : shapeOf(doc, e.dict, kind, rect),
      color: colourOf(doc, e.dict, 'C'),
      opacity: ca === null ? 1 : ca,
      author: text(e.dict, 'T'),
      contents: text(e.dict, 'Contents') ?? '',
      modified,
      created: parsePdfDate(text(e.dict, 'CreationDate')),
      inReplyTo,
      review: null,
    })
  }
  for (const a of out) a.review = reviews.get(a.id) ?? null
  return out
}

// ---------------------------------------------------------------------------
// Appearance streams

const f = (n: number) => {
  const r = Math.round(n * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}
const rgbOp = (c: Rgb, stroke: boolean) => `${c.map(f).join(' ')} ${stroke ? 'RG' : 'rg'}`
/** Bézier circle constant. */
const K = 0.5523

/** A primitive as content-stream operators; text through `encode` (the font's codes). */
export function operatorsOf(prims: Primitive[], encode: (s: string) => string): string {
  const ops: string[] = []
  for (const p of prims) {
    ops.push('q')
    if (p.t === 'text') {
      ops.push('BT', rgbOp(p.color, false), `/Helv ${f(p.size)} Tf`)
      p.lines.forEach((line, i) => {
        if (i === 0) ops.push(`${f(p.x)} ${f(p.y)} Td`)
        else ops.push(`0 ${f(-p.size * 1.2)} Td`)
        ops.push(`${encode(line)} Tj`)
      })
      ops.push('ET', 'Q')
      continue
    }
    if (p.stroke) ops.push(rgbOp(p.stroke, true), `${f(p.width)} w`)
    if (p.fill) ops.push(rgbOp(p.fill, false))
    if (p.t === 'path' && p.round) ops.push('1 J 1 j')
    if (p.t === 'path') {
      for (const pts of p.paths) {
        for (let i = 0; i + 1 < pts.length; i += 2)
          ops.push(`${f(pts[i]!)} ${f(pts[i + 1]!)} ${i === 0 ? 'm' : 'l'}`)
        if (p.closed) ops.push('h')
      }
    } else {
      const { cx, cy, rx, ry } = p
      const [kx, ky] = [rx * K, ry * K]
      ops.push(
        `${f(cx + rx)} ${f(cy)} m`,
        `${f(cx + rx)} ${f(cy + ky)} ${f(cx + kx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c`,
        `${f(cx - kx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ky)} ${f(cx - rx)} ${f(cy)} c`,
        `${f(cx - rx)} ${f(cy - ky)} ${f(cx - kx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c`,
        `${f(cx + kx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ky)} ${f(cx + rx)} ${f(cy)} c`,
        'h',
      )
    }
    ops.push(p.fill && p.stroke ? 'B' : p.fill ? 'f' : 'S', 'Q')
  }
  return ops.join('\n')
}

/** Helvetica's widths, for laying out text boxes the same way on screen and in the file. */
export async function helveticaMeasure(
  doc: PDFDocument,
): Promise<{ font: PDFFont; measure: Measure }> {
  const font = await doc.embedFont(StandardFonts.Helvetica)
  return { font, measure: (s, size) => font.widthOfTextAtSize(s, size) }
}

type Writer = {
  doc: PDFDocument
  ctx: EditContext
  helv: () => Promise<{ font: PDFFont; measure: Measure }>
}

function encoderOf(font: PDFFont) {
  return (s: string) => {
    try {
      return font.encodeText(s).toString()
    } catch {
      const bad = [...s].find((ch) => {
        try {
          font.encodeText(ch)
          return false
        } catch {
          return true
        }
      })
      throw new PdfEditError(
        `A text box can’t show “${bad ?? s}”: the standard PDF font has no such character. Use a note for that text.`,
      )
    }
  }
}

async function writeAppearance(
  w: Writer,
  dict: PDFDict,
  shape: AnnotationShape,
  color: Rgb,
  opacity: number,
  contents: string,
) {
  // Only a text box draws text: the font joins the file only then.
  const font = shape.kind === 'FreeText' ? (await w.helv()).font : null
  const measure: Measure = (s, size) => (font ? font.widthOfTextAtSize(s, size) : 0)
  const prims = appearanceOf(shape, color, contents, measure)
  const rect = rectOf(shape)
  const body = operatorsOf(prims, (s) => {
    if (!font) throw new Error('text outside a text box')
    return encoderOf(font)(s)
  })
  const gs: Record<string, number | string> = { Type: 'ExtGState', CA: opacity, ca: opacity }
  if (shape.kind === 'Highlight') gs.BM = 'Multiply'
  const resources: Record<string, unknown> = { ExtGState: { GS0: gs } }
  if (font) resources.Font = { Helv: font.ref }
  const stream = w.doc.context.stream(`/GS0 gs\n${body}`, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: rect,
    Resources: resources as never,
  })
  dict.set(N('AP'), w.doc.context.obj({ N: w.doc.context.register(stream) }))
  dict.set(N('Rect'), w.doc.context.obj(rect))
}

// ---------------------------------------------------------------------------
// Writing

const rgbArray = (w: Writer, c: Rgb) => w.doc.context.obj(c)

/** Sets the keys a shape is written as (geometry only). */
function setGeometry(w: Writer, dict: PDFDict, shape: AnnotationShape) {
  const ctx = w.doc.context
  switch (shape.kind) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly':
      dict.set(N('QuadPoints'), ctx.obj(shape.quads.flat()))
      break
    case 'Text':
      break
    case 'Ink':
      dict.set(N('InkList'), ctx.obj(shape.paths))
      dict.set(N('BS'), ctx.obj({ Type: 'Border', W: shape.width, S: 'S' }))
      break
    case 'FreeText':
      dict.set(N('DA'), PDFString.of(`/Helv ${f(shape.fontSize)} Tf 0 g`))
      dict.set(N('BS'), ctx.obj({ Type: 'Border', W: 1, S: 'S' }))
      break
    case 'Square':
    case 'Circle':
      dict.set(N('BS'), ctx.obj({ Type: 'Border', W: shape.width, S: 'S' }))
      if (shape.fill) dict.set(N('IC'), ctx.obj(shape.fill))
      else dict.delete(N('IC'))
      break
    case 'Line':
      dict.set(N('L'), ctx.obj(shape.line))
      dict.set(N('LE'), ctx.obj(shape.ends))
      dict.set(N('BS'), ctx.obj({ Type: 'Border', W: shape.width, S: 'S' }))
      break
  }
  dict.set(N('Rect'), ctx.obj(rectOf(shape)))
}

function stamp(w: Writer, dict: PDFDict, created: boolean) {
  const at = PDFString.of(pdfDate(w.ctx.now))
  dict.set(N('M'), at)
  if (created) {
    dict.set(N('CreationDate'), at)
    dict.set(N('T'), PDFHexString.fromText(w.ctx.author))
    dict.set(N('NM'), PDFHexString.fromText(randomUuid()))
  }
}

function newDict(w: Writer, subtype: string, pageRef: PDFRef, flags: number): PDFDict {
  return w.doc.context.obj({ Type: 'Annot', Subtype: subtype, P: pageRef, F: flags })
}

/**
 * Adds to a page's /Annots without pdf-lib's addAnnot, which "normalises"
 * the page — wraps its content streams in q/Q — and so changes the page.
 */
function pushAnnot(doc: PDFDocument, page: PDFPage, ref: PDFRef) {
  const annots = page.node.Annots()
  if (annots) annots.push(ref)
  else page.node.set(N('Annots'), doc.context.obj([ref]))
}

function dropAnnot(page: PDFPage, ref: PDFRef) {
  const annots = page.node.Annots()
  if (!annots) return
  for (let i = annots.size() - 1; i >= 0; i--) if (annots.get(i) === ref) annots.remove(i)
}

type Index = { refs: Map<string, PDFRef>; page: Map<string, number> }

function indexOf(doc: PDFDocument): Index {
  const refs = new Map<string, PDFRef>()
  const page = new Map<string, number>()
  for (const e of entriesOf(doc)) {
    if (!e.ref) continue
    refs.set(idOfRef(e.ref), e.ref)
    page.set(idOfRef(e.ref), e.page)
  }
  return { refs, page }
}

/** Direct annotation dictionaries become objects of their own, so edits can refer to them. */
function indirectAll(doc: PDFDocument) {
  for (const page of doc.getPages()) {
    const annots = page.node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i)
      if (raw instanceof PDFDict) annots.set(i, doc.context.register(raw))
    }
  }
}

async function addAnnotation(
  w: Writer,
  index: Index,
  key: string,
  a: NewAnnotation,
): Promise<PDFRef> {
  checkShape(a.shape)
  const pages = w.doc.getPages()
  const page = pages[a.page]
  if (!page)
    throw new PdfEditError(`There is no page ${a.page + 1}; the PDF has ${pages.length} pages.`)
  if (!(a.opacity > 0 && a.opacity <= 1))
    throw new PdfEditError('Opacity is between 0 (exclusive) and 1.')
  const kind = a.shape.kind
  const flags = kind === 'Text' ? F_PRINT | F_NO_ZOOM | F_NO_ROTATE : F_PRINT
  const dict = newDict(w, kind, page.ref, flags)
  dict.set(N('C'), rgbArray(w, a.color))
  if (a.opacity !== 1) dict.set(N('CA'), PDFNumber.of(a.opacity))
  dict.set(N('Contents'), PDFHexString.fromText(a.contents ?? ''))
  if (kind === 'Text') dict.set(N('Name'), N('Comment'))
  if (kind === 'FreeText' && !(a.contents ?? '').trim())
    throw new PdfEditError('A text box needs some text.')
  setGeometry(w, dict, a.shape)
  stamp(w, dict, true)
  await writeAppearance(w, dict, a.shape, a.color, a.opacity, a.contents ?? '')
  const ref = w.doc.context.register(dict)
  pushAnnot(w.doc, page, ref)
  index.refs.set(key, ref)
  index.page.set(key, a.page)
  return ref
}

function target(w: Writer, index: Index, id: string): { ref: PDFRef; dict: PDFDict; page: number } {
  const ref = index.refs.get(id)
  const dict = ref ? w.doc.context.lookupMaybe(ref, PDFDict) : undefined
  if (!ref || !dict) throw new PdfEditError(`There is no annotation ${id} in this PDF.`)
  return { ref, dict, page: index.page.get(id)! }
}

function kindOf(dict: PDFDict): AnnotationKind | null {
  const s = name(dict, 'Subtype')
  return s && isKind(s) ? s : null
}

function shiftKey(w: Writer, dict: PDFDict, key: string, dx: number, dy: number) {
  const v = dict.get(N(key))
  if (!v) return
  const shift = (arr: number[]) => arr.map((n, i) => n + (i % 2 === 0 ? dx : dy))
  if (key === 'InkList') {
    const list = w.doc.context.lookupMaybe(v, PDFArray)
    if (!list) return
    const paths: number[][] = []
    for (let i = 0; i < list.size(); i++) paths.push(shift(nums(w.doc, list.get(i)) ?? []))
    dict.set(N(key), w.doc.context.obj(paths))
    return
  }
  const arr = nums(w.doc, v)
  if (arr) dict.set(N(key), w.doc.context.obj(shift(arr)))
}

async function updateAnnotation(
  w: Writer,
  index: Index,
  id: string,
  patch: Extract<AnnotationEdit, { op: 'update' }>['patch'],
) {
  const { dict } = target(w, index, id)
  const kind = kindOf(dict)
  if ((patch.color || patch.shape || patch.opacity !== undefined) && !kind)
    throw new PdfEditError(
      `A ${name(dict, 'Subtype') ?? 'such'} annotation can only be moved here, not redrawn.`,
    )
  if (patch.shape && patch.shape.kind !== kind)
    throw new PdfEditError('An annotation keeps its kind.')
  if (patch.opacity !== undefined && !(patch.opacity > 0 && patch.opacity <= 1))
    throw new PdfEditError('Opacity is between 0 (exclusive) and 1.')
  if (patch.shape) {
    checkShape(patch.shape)
    setGeometry(w, dict, patch.shape)
  }
  if (patch.color) dict.set(N('C'), rgbArray(w, patch.color))
  if (patch.opacity !== undefined) {
    if (patch.opacity === 1) dict.delete(N('CA'))
    else dict.set(N('CA'), PDFNumber.of(patch.opacity))
  }
  if (patch.contents !== undefined) {
    if (kind === 'FreeText' && !patch.contents.trim())
      throw new PdfEditError('A text box needs some text.')
    dict.set(N('Contents'), PDFHexString.fromText(patch.contents))
  }
  if (patch.move) {
    const [dx, dy] = patch.move
    const r = nums(w.doc, dict.get(N('Rect')))
    if (r && r.length === 4) dict.set(N('Rect'), w.doc.context.obj(moveRect(r as Rect, dx, dy)))
    for (const key of ['QuadPoints', 'InkList', 'L', 'Vertices', 'CL'])
      shiftKey(w, dict, key, dx, dy)
  }
  stamp(w, dict, false)
  const redraw =
    patch.color ||
    patch.shape ||
    patch.opacity !== undefined ||
    (patch.contents !== undefined && kind === 'FreeText')
  if (redraw && kind) {
    const rect = normRect((nums(w.doc, dict.get(N('Rect'))) ?? [0, 0, 0, 0]) as Rect)
    const shape = patch.shape && !patch.move ? patch.shape : shapeOf(w.doc, dict, kind, rect)
    const ca = num(dict, 'CA')
    await writeAppearance(
      w,
      dict,
      shape,
      colourOf(w.doc, dict, 'C') ?? [0, 0, 0],
      ca ?? 1,
      text(dict, 'Contents') ?? '',
    )
  }
}

function deleteAnnotation(w: Writer, index: Index, id: string) {
  const first = target(w, index, id)
  const gone = new Set<PDFRef>([first.ref])
  // Replies and state annotations go with what they answer; popups with their note.
  const all = entriesOf(w.doc)
  for (let grew = true; grew;) {
    grew = false
    for (const e of all) {
      const irt = e.dict.get(N('IRT'))
      const parent = e.dict.get(N('Parent'))
      const of =
        e.ref &&
        ((irt instanceof PDFRef && gone.has(irt)) || (parent instanceof PDFRef && gone.has(parent)))
      if (of && e.ref && !gone.has(e.ref)) {
        gone.add(e.ref)
        grew = true
      }
    }
  }
  for (const ref of [...gone]) {
    const popup = w.doc.context.lookupMaybe(ref, PDFDict)?.get(N('Popup'))
    if (popup instanceof PDFRef) gone.add(popup)
  }
  for (const page of w.doc.getPages()) for (const ref of gone) dropAnnot(page, ref)
  for (const ref of gone) {
    w.doc.context.delete(ref)
    for (const [k, v] of index.refs) if (v === ref) index.refs.delete(k)
  }
}

function addReply(w: Writer, index: Index, key: string, to: string, contents: string) {
  if (!contents.trim()) throw new PdfEditError('A reply needs some text.')
  const parent = target(w, index, to)
  const page = w.doc.getPages()[parent.page]!
  const dict = newDict(w, 'Text', page.ref, F_PRINT | F_NO_ZOOM | F_NO_ROTATE)
  const rect = parent.dict.get(N('Rect'))
  dict.set(
    N('Rect'),
    rect ? w.doc.context.obj(nums(w.doc, rect) ?? [0, 0, 0, 0]) : w.doc.context.obj([0, 0, 0, 0]),
  )
  dict.set(N('IRT'), parent.ref)
  dict.set(N('RT'), N('R'))
  dict.set(N('Name'), N('Comment'))
  dict.set(N('Contents'), PDFHexString.fromText(contents))
  const c = parent.dict.get(N('C'))
  if (c) dict.set(N('C'), c)
  stamp(w, dict, true)
  const ref = w.doc.context.register(dict)
  pushAnnot(w.doc, page, ref)
  index.refs.set(key, ref)
  index.page.set(key, parent.page)
}

/** One Review state per author (§12.5.6.3): a hidden note in reply to the annotation. */
function setReview(w: Writer, index: Index, id: string, state: ReviewState) {
  if (!isReview(state)) throw new PdfEditError(`“${state}” is not a review state.`)
  const parent = target(w, index, id)
  const mine = entriesOf(w.doc).find((e) => {
    const irt = e.dict.get(N('IRT'))
    return (
      irt instanceof PDFRef &&
      irt === parent.ref &&
      textOrName(e.dict, 'StateModel') === 'Review' &&
      text(e.dict, 'T') === w.ctx.author
    )
  })
  const setState = (dict: PDFDict) => {
    dict.set(N('State'), PDFString.of(state))
    dict.set(N('Contents'), PDFHexString.fromText(`${state} set by ${w.ctx.author}`))
  }
  if (mine) {
    setState(mine.dict)
    stamp(w, mine.dict, false)
    return
  }
  const page = w.doc.getPages()[parent.page]!
  const dict = newDict(w, 'Text', page.ref, F_HIDDEN | F_NO_ZOOM | F_NO_ROTATE)
  dict.set(N('Rect'), w.doc.context.obj(nums(w.doc, parent.dict.get(N('Rect'))) ?? [0, 0, 0, 0]))
  dict.set(N('IRT'), parent.ref)
  dict.set(N('StateModel'), PDFString.of('Review'))
  setState(dict)
  stamp(w, dict, true)
  pushAnnot(w.doc, page, w.doc.context.register(dict))
}

/**
 * Writes staged edits into `doc`, in order. Returns the id each new
 * annotation got (key → id). Throws PdfEditError on an edit that can't apply.
 */
export async function applyAnnotationEdits(
  doc: PDFDocument,
  edits: AnnotationEdit[],
  ctx: EditContext,
): Promise<Record<string, string>> {
  if (!ctx.author.trim()) throw new PdfEditError('Annotations need an author.')
  indirectAll(doc)
  const index = indexOf(doc)
  let helv: Promise<{ font: PDFFont; measure: Measure }> | null = null
  const w: Writer = { doc, ctx, helv: () => (helv ??= helveticaMeasure(doc)) }
  const created: Record<string, string> = {}
  for (const e of edits) {
    switch (e.op) {
      case 'add':
        created[e.key] = idOfRef(await addAnnotation(w, index, e.key, e.annotation))
        break
      case 'reply':
        addReply(w, index, e.key, e.to, e.contents)
        created[e.key] = idOfRef(index.refs.get(e.key)!)
        break
      case 'update':
        await updateAnnotation(w, index, e.id, e.patch)
        break
      case 'delete':
        deleteAnnotation(w, index, e.id)
        break
      case 'review':
        setReview(w, index, e.id, e.state)
        break
    }
  }
  return created
}
