import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { strToU8 } from 'fflate'
import { relsPartOf, type OpcPackage } from '../ooxml/package'
import {
  CT_MODERN_AUTHORS,
  CT_MODERN_COMMENTS,
  EXT_COMMENT_REL,
  legacyCommentPart,
  modernAuthorsPart,
  modernCommentPart,
  NS_A16,
  NS_AC,
  NS_P188,
  NS_PC,
  PROVIDER,
  REL_MODERN_AUTHORS,
  REL_MODERN_COMMENTS,
} from './comments'
import { imageSize } from './media'
import { PptxError, presentationPart, readDeck, sourceOf, walkShapes, type Deck, type GroupXfrm, type ShapeNode, type Slide, type Xfrm } from './model'
import { findPlaceholder, resolveSlide, type RNode } from './resolve'
import { a, attr, children, intAttr, isEl, kids, NS, p, REL_TYPE } from './xml'

/**
 * Editing a deck (plan/phase-office-files.md, S2) as operations: plain,
 * serializable data that names slides by part and shapes by their cNvPr id
 * (never by object links), so they can be kept in a history, replayed, or
 * sent elsewhere.
 *
 * Each operation changes the package's XML as little as it can (ECMA-376
 * Part 1 §19 PresentationML, §20–21 DrawingML; Part 2 OPC): only the parts it
 * must touch are rewritten, and inside an edited element every attribute and
 * child it does not set stays (extLst, mc:AlternateContent, a14:* …). New
 * parts get their content type and relationships; presentation.xml's slide
 * list, ids, custom shows and sections stay consistent.
 *
 * Undo is exact: applying an operation records the bytes of every part it
 * changed, and its inverse (`restoreParts`) puts those bytes back — the
 * original XML byte for byte, not a re-serialisation of it.
 */

// ---------------------------------------------------------------------------
// Operations

/** A box in EMU. */
export type Box = { x: number; y: number; cx: number; cy: number }
/** New position/size/rotation (degrees); fields left out keep their value. */
export type XfrmPatch = Partial<Box & { rot: number }>

/** A run of the shape's text as it is now: paragraph and run index. */
export type RunRef = { p: number; r: number }
/** One run of edited text; `from` is the run whose formatting it keeps (null: the paragraph's end formatting). */
export type RunEdit = { kind: 'text'; text: string; from: RunRef | null } | { kind: 'break'; from: RunRef | null }
/** One paragraph of edited text; `from` is the paragraph whose paragraph properties it keeps. */
export type ParagraphEdit = { from: number | null; runs: RunEdit[] }

/** A place in a shape's text: paragraph, run, and character offset in that run (a run index past the last run is the paragraph end). */
export type TextPos = { p: number; r: number; o: number }
export type TextRange = { start: TextPos; end: TextPos }

/** Character formatting; `size` in 1/100 pt, `color` as RRGGBB. */
export type RunFormat = { bold?: boolean; italic?: boolean; underline?: boolean; size?: number; color?: string }
export type Align = 'l' | 'ctr' | 'r' | 'just'

/** A part as it was: its bytes and content type, or absent (null). */
export type PartState = { part: string; bytes: Uint8Array | null; contentType: string | null }

export type DeckOp =
  | { kind: 'setText'; slide: string; shape: string; paragraphs: ParagraphEdit[] }
  | { kind: 'formatRuns'; slide: string; shape: string; range: TextRange | null; format: RunFormat }
  | { kind: 'formatParagraphs'; slide: string; shape: string; paragraphs: number[] | null; align?: Align; bullets?: boolean }
  | { kind: 'setXfrm'; slide: string; shape: string; xfrm: XfrmPatch }
  | { kind: 'arrange'; slide: string; shape: string; dir: 'forward' | 'backward' }
  | { kind: 'deleteShape'; slide: string; shape: string }
  | { kind: 'duplicateShape'; slide: string; shape: string }
  | { kind: 'insertTextBox'; slide: string; box: Box; text: string }
  | { kind: 'insertPicture'; slide: string; bytes: Uint8Array; contentType: string; name: string; box?: Box }
  | { kind: 'addSlide'; layout: string; at: number }
  | { kind: 'duplicateSlide'; slide: string }
  | { kind: 'deleteSlide'; slide: string }
  | { kind: 'moveSlide'; slide: string; to: number }
  | { kind: 'setHidden'; slide: string; hidden: boolean }
  | { kind: 'setNotes'; slide: string; text: string }
  | { kind: 'addComment'; slide: string; id: string; author: CommentMember; created: string; text: string; anchor: NewCommentAnchor; pos: { x: number; y: number } | null }
  | { kind: 'replyComment'; slide: string; comment: string; id: string; author: CommentMember; created: string; text: string }
  | { kind: 'editComment'; slide: string; comment: string; reply: string | null; author: CommentMember; text: string }
  | { kind: 'setCommentStatus'; slide: string; comment: string; status: 'active' | 'resolved' }
  | { kind: 'deleteComment'; slide: string; comment: string; reply: string | null; author: CommentMember }
  | { kind: 'batch'; ops: DeckOp[] }
  | { kind: 'restoreParts'; parts: PartState[] }

/** The signed-in member writing a comment (the Drive's member id and name). */
export type CommentMember = { id: string; name: string }
/** Where a new comment goes: the slide, or a shape on it (by cNvPr id). */
export type NewCommentAnchor = { kind: 'slide' } | { kind: 'shape'; shape: string }

export type OpResult = {
  /** Puts every changed part back exactly as it was. */
  inverse: Extract<DeckOp, { kind: 'restoreParts' }>
  /** The parts whose bytes changed (empty: the operation changed nothing). */
  touched: string[]
  /** What the operation made: a slide, or a shape on a slide. */
  created: { slide: string; shape?: string } | null
}

// ---------------------------------------------------------------------------
// Constants

const CT = 'application/vnd.openxmlformats-officedocument.presentationml'
const CT_SLIDE = `${CT}.slide+xml`
const CT_NOTES = `${CT}.notesSlide+xml`
const CT_NOTES_MASTER = `${CT}.notesMaster+xml`
const CT_THEME = 'application/vnd.openxmlformats-officedocument.theme+xml'
const CT_RELS = 'application/vnd.openxmlformats-package.relationships+xml'
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const NS_DECL = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`

/** Picture formats PowerPoint and browsers both show, by content type → file extension. */
const PICTURE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/bmp': 'bmp' }

/** Child order of the elements this module inserts into (ECMA-376 Part 1 schemas). */
const ORDER = {
  spPr: ['xfrm', 'custGeom', 'prstGeom', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'ln', 'effectLst', 'effectDag', 'scene3d', 'sp3d', 'extLst'],
  grpSpPr: ['xfrm', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'effectLst', 'effectDag', 'scene3d', 'extLst'],
  xfrm: ['off', 'ext', 'chOff', 'chExt'],
  pPr: ['lnSpc', 'spcBef', 'spcAft', 'buClrTx', 'buClr', 'buSzTx', 'buSzPct', 'buSzPts', 'buFontTx', 'buFont', 'buNone', 'buAutoNum', 'buChar', 'buBlip', 'tabLst', 'defRPr', 'extLst'],
  rPr: ['ln', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'effectLst', 'effectDag', 'highlight', 'uLnTx', 'uLn', 'uFillTx', 'uFill', 'latin', 'ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst'],
  presentation: ['sldMasterIdLst', 'notesMasterIdLst', 'handoutMasterIdLst', 'sldIdLst', 'sldSz', 'notesSz', 'smartTags', 'embeddedFontLst', 'custShowLst', 'photoAlbum', 'custDataLst', 'kinsoku', 'defaultTextStyle', 'modifyVerifier', 'extLst'],
} as const
const FILLS = new Set(['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'])
const BULLETS = new Set(['buNone', 'buAutoNum', 'buChar', 'buBlip'])
/** The non-visual properties element of each shape element. */
const NV: Record<string, string> = { sp: 'nvSpPr', cxnSp: 'nvCxnSpPr', pic: 'nvPicPr', grpSp: 'nvGrpSpPr', graphicFrame: 'nvGraphicFramePr', contentPart: 'nvContentPartPr' }
/** Layout placeholders a new slide does not get (slide furniture: date, footer, number). */
const FURNITURE = new Set(['dt', 'ftr', 'sldNum', 'hdr'])

// ---------------------------------------------------------------------------
// Recording what an operation changes

type Rec = {
  pkg: OpcPackage
  doc(part: string): XMLDocument
  save(part: string, doc: XMLDocument): void
  put(part: string, bytes: Uint8Array, contentType: string): void
  drop(part: string): void
  rel(source: string, type: string, target: string): string
  before: Map<string, PartState>
  read: Set<string>
}

function recorder(pkg: OpcPackage): Rec {
  const before = new Map<string, PartState>()
  const read = new Set<string>()
  const note = (part: string) => {
    const k = part.toLowerCase()
    if (before.has(k)) return
    before.set(k, pkg.has(part) ? { part, bytes: pkg.bytes(part), contentType: pkg.contentType(part) } : { part, bytes: null, contentType: null })
  }
  return {
    pkg,
    before,
    read,
    doc(part) {
      read.add(part)
      return pkg.xml(part)
    },
    save(part, doc) {
      note(part)
      pkg.setXml(part, doc)
    },
    put(part, bytes, contentType) {
      note(part)
      pkg.setBytes(part, bytes, pkg.has(part) && pkg.contentType(part) === contentType ? undefined : contentType)
    },
    drop(part) {
      note(part)
      pkg.remove(part)
    },
    rel(source, type, target) {
      note(relsPartOf(source))
      return pkg.addRelationship(source, type, target)
    },
  }
}

const sameBytes = (x: Uint8Array | null, y: Uint8Array | null) => {
  if (x === y) return true
  if (!x || !y || x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

/**
 * Applies `op` to the package. Throws PptxError (nothing changed) when the
 * operation does not fit the deck; on any failure the package is left as it
 * was.
 */
export function applyOp(pkg: OpcPackage, op: DeckOp): OpResult {
  const rec = recorder(pkg)
  let created: OpResult['created']
  try {
    created = run(rec, op)
  } catch (err) {
    rollback(rec)
    throw err
  }
  dropUnsaved(rec)
  const parts: PartState[] = []
  const touched: string[] = []
  for (const was of rec.before.values()) {
    const now = pkg.has(was.part) ? pkg.bytes(was.part) : null
    if (sameBytes(was.bytes, now)) continue
    parts.push(was)
    touched.push(was.part)
  }
  return { inverse: { kind: 'restoreParts', parts }, touched, created }
}

function rollback(rec: Rec) {
  restore(rec.pkg, [...rec.before.values()])
  dropUnsaved(rec)
}

/** Parts read (and maybe edited in memory) but not saved: their cached DOM goes, the bytes stay. */
function dropUnsaved(rec: Rec) {
  for (const part of rec.read) if (rec.pkg.has(part) && !rec.before.has(part.toLowerCase())) rec.pkg.setBytes(part, rec.pkg.bytes(part))
}

function restore(pkg: OpcPackage, parts: PartState[]) {
  for (const s of parts) {
    if (s.bytes === null) {
      if (pkg.has(s.part)) pkg.remove(s.part)
    } else {
      const same = pkg.has(s.part) && pkg.contentType(s.part) === s.contentType
      pkg.setBytes(s.part, s.bytes, same ? undefined : (s.contentType ?? undefined))
    }
  }
}

function run(rec: Rec, op: DeckOp): OpResult['created'] {
  switch (op.kind) {
    case 'batch': {
      let created: OpResult['created'] = null
      for (const sub of op.ops) created = run(rec, sub) ?? created
      return created
    }
    case 'restoreParts':
      for (const s of op.parts) {
        if (s.bytes === null) {
          if (rec.pkg.has(s.part)) rec.drop(s.part)
        } else rec.put(s.part, s.bytes, s.contentType ?? rec.pkg.contentType(s.part))
      }
      return null
    case 'setText':
      return setText(rec, op)
    case 'formatRuns':
      return formatRuns(rec, op)
    case 'formatParagraphs':
      return formatParagraphs(rec, op)
    case 'setXfrm':
      return setXfrm(rec, op)
    case 'arrange':
      return arrange(rec, op)
    case 'deleteShape':
      return deleteShape(rec, op)
    case 'duplicateShape':
      return duplicateShape(rec, op)
    case 'insertTextBox':
      return insertTextBox(rec, op)
    case 'insertPicture':
      return insertPicture(rec, op)
    case 'addSlide':
      return addSlide(rec, op)
    case 'duplicateSlide':
      return duplicateSlide(rec, op)
    case 'deleteSlide':
      return deleteSlide(rec, op)
    case 'moveSlide':
      return moveSlide(rec, op)
    case 'setHidden':
      return setHidden(rec, op)
    case 'setNotes':
      return setNotes(rec, op)
    case 'addComment':
      return addComment(rec, op)
    case 'replyComment':
      return replyComment(rec, op)
    case 'editComment':
      return editComment(rec, op)
    case 'setCommentStatus':
      return setCommentStatus(rec, op)
    case 'deleteComment':
      return deleteComment(rec, op)
  }
}

// ---------------------------------------------------------------------------
// DOM helpers

const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function elementKids(el: Node): Element[] {
  const out: Element[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) if (isEl(n)) out.push(n)
  return out
}

const PREFIX: Record<string, string> = { [NS.a]: 'a', [NS.p]: 'p', [NS.r]: 'r' }

/** A new element in `ns`, with the prefix the document already uses for it. */
function mk(doc: XMLDocument, ns: string, local: string, attrs: Record<string, string> = {}): Element {
  const prefix = doc.documentElement?.lookupPrefix(ns) ?? PREFIX[ns] ?? null
  const el = doc.createElementNS(ns, prefix ? `${prefix}:${local}` : local)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

/** Parses markup written with the a/p/r prefixes into `doc`. */
function fragment(doc: XMLDocument, xml: string): Element {
  const wrap = new DOMParser().parseFromString(`<w ${NS_DECL}>${xml}</w>`, 'application/xml') as unknown as XMLDocument
  const el = elementKids(wrap.documentElement!)[0]
  if (!el) throw new Error('Empty fragment.')
  return doc.importNode(el, true) as Element
}

function parseXml(text: string): XMLDocument {
  return new DOMParser().parseFromString(text, 'application/xml') as unknown as XMLDocument
}

/** Inserts `el` into `parent` where the schema's child order puts it. */
function insertOrdered(parent: Element, el: Element, order: readonly string[]) {
  const at = order.indexOf(el.localName)
  for (const k of elementKids(parent)) {
    const i = order.indexOf(k.localName)
    if (i > at) {
      parent.insertBefore(el, k)
      return
    }
  }
  parent.appendChild(el)
}

/** The child `local` of `parent` in `ns`, created in schema order when missing. */
function ensure(parent: Element, ns: string, local: string, order: readonly string[]): Element {
  const found = elementKids(parent).find((k) => k.namespaceURI === ns && k.localName === local)
  if (found) return found
  const el = mk(parent.ownerDocument!, ns, local)
  insertOrdered(parent, el, order)
  return el
}

function setText_(el: Element, text: string) {
  while (el.firstChild) el.removeChild(el.firstChild)
  el.appendChild(el.ownerDocument!.createTextNode(text))
}

/** The relative Target from `from`'s folder to part `to` (OPC part names). */
export function relativeTarget(from: string, to: string): string {
  const fromDir = from.split('/').slice(1, -1)
  const toSegs = to.split('/').slice(1)
  let common = 0
  while (common < fromDir.length && common < toSegs.length - 1 && fromDir[common] === toSegs[common]) common++
  return [...fromDir.slice(common).map(() => '..'), ...toSegs.slice(common)].join('/')
}

/** A part name `${folder}/${stem}${n}.${ext}` not in the package yet. */
function freshPart(pkg: OpcPackage, folder: string, stem: string, ext: string): string {
  for (let n = 1; ; n++) {
    const part = `${folder}/${stem}${n}.${ext}`
    if (!pkg.has(part)) return part
  }
}

function relsXml(rels: Array<{ id: string; type: string; target: string }>): string {
  return `${XML_DECL}<Relationships xmlns="${NS_REL}">${rels.map((r) => `<Relationship Id="${escXml(r.id)}" Type="${escXml(r.type)}" Target="${escXml(r.target)}"/>`).join('')}</Relationships>`
}

const GROUP_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

// ---------------------------------------------------------------------------
// Finding things

function deckOf(rec: Rec): Deck {
  return readDeck(rec.pkg)
}

function slideOf(deck: Deck, part: string): Slide {
  const s = deck.slides.find((x) => x.part === part)
  if (!s) throw new PptxError(`The deck has no slide ${part}.`)
  return s
}

type Found = { slide: Slide; node: ShapeNode; el: Element }

function shapeOf(rec: Rec, deck: Deck, slidePart: string, id: string): Found {
  const slide = slideOf(deck, slidePart)
  // Its DOM may be edited: a failed or empty operation drops those edits again (see applyOp).
  rec.read.add(slide.part)
  const hits = [...walkShapes(slide.shapes)].filter((s) => s.id === id && s.kind !== 'other')
  if (hits.length === 0) throw new PptxError(`Slide ${slide.number} has no shape ${id}.`)
  if (hits.length > 1) throw new PptxError(`Slide ${slide.number} has more than one shape with id ${id}; it can't be edited safely.`)
  const node = hits[0]!
  const src = sourceOf(node)
  if (!src) throw new PptxError(`Shape ${id} on slide ${slide.number} has no source in the file.`)
  return { slide, node, el: src.el }
}

const isAlt = (el: Node | null) => !!el && isEl(el) && el.namespaceURI === NS.mc && el.localName === 'AlternateContent'
const isBranch = (el: Node | null) => !!el && isEl(el) && el.namespaceURI === NS.mc && (el.localName === 'Choice' || el.localName === 'Fallback')

/** The element that sits in the shape tree for `el`: itself, or its mc:AlternateContent wrapper. */
function slotOf(el: Element): Element {
  let cur = el
  while (isBranch(cur.parentNode) && isAlt(cur.parentNode!.parentNode)) cur = cur.parentNode!.parentNode as Element
  return cur
}

function cNvPrOf(el: Element): Element | null {
  const nv = NV[el.localName]
  return nv ? p(p(el, nv), 'cNvPr') : null
}

/** `el` and the same shape in the other branches of its mc:AlternateContent (same cNvPr id). */
function twins(el: Element): Element[] {
  if (!isBranch(el.parentNode) || !isAlt(el.parentNode!.parentNode)) return [el]
  const id = attr(cNvPrOf(el), 'id')
  const out: Element[] = []
  for (const branch of elementKids(el.parentNode!.parentNode!)) {
    if (!isBranch(branch)) continue
    for (const k of elementKids(branch)) if (k.namespaceURI === NS.p && k.localName === el.localName && attr(cNvPrOf(k), 'id') === id) out.push(k)
  }
  return out
}

/** Shapes elements of a tree (p:spTree or p:grpSp), in z-order, as their slots. */
function shapeSlots(tree: Element): Element[] {
  return elementKids(tree).filter((k) => isAlt(k) || (k.namespaceURI === NS.p && k.localName in NV))
}

function spTreeOf(doc: XMLDocument): Element {
  const root = doc.documentElement as unknown as Element
  const tree = p(p(root, 'cSld'), 'spTree')
  if (!tree) throw new PptxError('The slide has no shape tree.')
  return tree
}

function maxShapeId(doc: XMLDocument): number {
  let max = 0
  const all = doc.getElementsByTagNameNS(NS.p, 'cNvPr')
  for (let i = 0; i < all.length; i++) max = Math.max(max, intAttr(all[i]!, 'id') ?? 0)
  return max
}

function appendShape(tree: Element, el: Element) {
  const ext = elementKids(tree).find((k) => k.namespaceURI === NS.p && k.localName === 'extLst')
  if (ext) tree.insertBefore(el, ext)
  else tree.appendChild(el)
}

/**
 * Where a shape sits: its own xfrm, or for a placeholder the layout's and
 * then the master's (matched by type and idx, as ./resolve.ts does).
 */
export function effectiveXfrm(deck: Deck, slide: Slide, node: ShapeNode): Xfrm | GroupXfrm | null {
  const own = xfrmOf(node)
  if (own || !node.ph) return own
  const layout = deck.layouts[slide.layout]
  const master = layout ? deck.masters[layout.master] : undefined
  const layoutPh = layout ? findPlaceholder(layout.shapes, node.ph, true) : null
  const fromLayout = layoutPh ? xfrmOf(layoutPh) : null
  if (fromLayout) return fromLayout
  const masterPh = master ? findPlaceholder(master.shapes, (layoutPh ?? node).ph!, false) : null
  return masterPh ? xfrmOf(masterPh) : null
}

function xfrmOf(s: ShapeNode): Xfrm | GroupXfrm | null {
  return s.kind === 'sp' || s.kind === 'pic' ? s.spPr.xfrm : s.kind === 'group' || s.kind === 'frame' || s.kind === 'other' ? s.xfrm : null
}

// ---------------------------------------------------------------------------
// Position and size

function writeXfrm(el: Element, current: Xfrm | GroupXfrm, patch: XfrmPatch) {
  const doc = el.ownerDocument!
  const local = el.localName
  let x: Element
  if (local === 'graphicFrame') {
    if (patch.rot !== undefined && patch.rot !== current.rot) throw new PptxError('Tables, charts and other frames cannot be rotated.')
    x = p(el, 'xfrm') ?? (() => {
      const made = mk(doc, NS.p, 'xfrm')
      const nv = p(el, 'nvGraphicFramePr')
      el.insertBefore(made, nv ? nv.nextSibling : el.firstChild)
      return made
    })()
  } else {
    const group = local === 'grpSp'
    const prName = group ? 'grpSpPr' : 'spPr'
    let pr = p(el, prName)
    if (!pr) {
      pr = mk(doc, NS.p, prName)
      const nv = p(el, NV[local]!)
      el.insertBefore(pr, nv ? nv.nextSibling : el.firstChild)
    }
    const had = a(pr, 'xfrm')
    x = ensure(pr, NS.a, 'xfrm', group ? ORDER.grpSpPr : ORDER.spPr)
    if (!had) {
      // A placeholder's own xfrm replaces the inherited one whole: keep its rotation and flips.
      if (current.rot) x.setAttribute('rot', String(Math.round(current.rot * 60000)))
      if (current.flipH) x.setAttribute('flipH', '1')
      if (current.flipV) x.setAttribute('flipV', '1')
    }
  }
  const off = ensure(x, NS.a, 'off', ORDER.xfrm)
  const ext = ensure(x, NS.a, 'ext', ORDER.xfrm)
  if (local === 'grpSp' && 'chX' in current && (!a(x, 'chOff') || !a(x, 'chExt'))) {
    // Without a child space, resizing the group would not scale its children.
    const chOff = ensure(x, NS.a, 'chOff', ORDER.xfrm)
    chOff.setAttribute('x', String(current.chX))
    chOff.setAttribute('y', String(current.chY))
    const chExt = ensure(x, NS.a, 'chExt', ORDER.xfrm)
    chExt.setAttribute('cx', String(current.chCx))
    chExt.setAttribute('cy', String(current.chCy))
  }
  const next = { x: current.x, y: current.y, cx: current.cx, cy: current.cy, ...patch }
  off.setAttribute('x', String(Math.round(next.x)))
  off.setAttribute('y', String(Math.round(next.y)))
  ext.setAttribute('cx', String(Math.max(0, Math.round(next.cx))))
  ext.setAttribute('cy', String(Math.max(0, Math.round(next.cy))))
  if (patch.rot !== undefined) {
    const deg = ((patch.rot % 360) + 360) % 360
    const v = Math.round(deg * 60000) % 21600000
    if (v === 0) x.removeAttribute('rot')
    else x.setAttribute('rot', String(v))
  }
}

function setXfrm(rec: Rec, op: Extract<DeckOp, { kind: 'setXfrm' }>) {
  const deck = deckOf(rec)
  const { slide, node, el } = shapeOf(rec, deck, op.slide, op.shape)
  const current = effectiveXfrm(deck, slide, node)
  if (!current) throw new PptxError(`${node.name || 'The shape'} has no position to change.`)
  for (const t of twins(el)) writeXfrm(t, current, op.xfrm)
  rec.save(slide.part, el.ownerDocument!)
  return null
}

// ---------------------------------------------------------------------------
// Shapes

function arrange(rec: Rec, op: Extract<DeckOp, { kind: 'arrange' }>) {
  const { slide, el } = shapeOf(rec, deckOf(rec), op.slide, op.shape)
  const slot = slotOf(el)
  const parent = slot.parentNode as Element
  const slots = shapeSlots(parent)
  const i = slots.indexOf(slot)
  if (op.dir === 'forward' && i < slots.length - 1) parent.insertBefore(slot, slots[i + 1]!.nextSibling)
  else if (op.dir === 'backward' && i > 0) parent.insertBefore(slot, slots[i - 1]!)
  else return null
  rec.save(slide.part, el.ownerDocument!)
  return null
}

function deleteShape(rec: Rec, op: Extract<DeckOp, { kind: 'deleteShape' }>) {
  const { slide, el } = shapeOf(rec, deckOf(rec), op.slide, op.shape)
  const slot = slotOf(el)
  slot.parentNode!.removeChild(slot)
  rec.save(slide.part, el.ownerDocument!)
  return null
}

/** How far a duplicate sits from its original (PowerPoint-like, a little down and right). */
const DUPLICATE_OFFSET = 182880

function duplicateShape(rec: Rec, op: Extract<DeckOp, { kind: 'duplicateShape' }>) {
  const deck = deckOf(rec)
  const { slide, node, el } = shapeOf(rec, deck, op.slide, op.shape)
  const doc = el.ownerDocument!
  const slot = slotOf(el)
  const copy = slot.cloneNode(true) as Element
  // New ids for every shape inside the copy (the same id in each mc branch), creation ids dropped.
  let next = maxShapeId(doc) + 1
  const ids = new Map<string, string>()
  const nvs = copy.getElementsByTagNameNS(NS.p, 'cNvPr')
  for (let i = 0; i < nvs.length; i++) {
    const c = nvs[i]!
    const old = c.getAttribute('id') ?? ''
    if (!ids.has(old)) ids.set(old, String(next++))
    c.setAttribute('id', ids.get(old)!)
    for (const k of elementKids(c)) if (k.namespaceURI === NS.a && k.localName === 'extLst') c.removeChild(k)
  }
  slot.parentNode!.insertBefore(copy, slot.nextSibling)
  const current = effectiveXfrm(deck, slide, node)
  if (current) {
    const shapesInCopy = isAlt(copy) ? elementKids(copy).flatMap((b) => (isBranch(b) ? elementKids(b) : [])) : [copy]
    for (const s of shapesInCopy) if (s.localName in NV) writeXfrm(s, current, { x: current.x + DUPLICATE_OFFSET, y: current.y + DUPLICATE_OFFSET })
  }
  rec.save(slide.part, doc)
  return { slide: slide.part, shape: ids.get(node.id)! }
}

function insertTextBox(rec: Rec, op: Extract<DeckOp, { kind: 'insertTextBox' }>) {
  const slide = slideOf(deckOf(rec), op.slide)
  const doc = rec.doc(slide.part)
  const id = maxShapeId(doc) + 1
  const paragraphs = op.text.split(/\r?\n/).map((line) => (line ? `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escXml(line)}</a:t></a:r></a:p>` : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>'))
  const el = fragment(
    doc,
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id - 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${Math.round(op.box.x)}" y="${Math.round(op.box.y)}"/><a:ext cx="${Math.round(op.box.cx)}" cy="${Math.round(op.box.cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
      `<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`,
  )
  appendShape(spTreeOf(doc), el)
  rec.save(slide.part, doc)
  return { slide: slide.part, shape: String(id) }
}

function insertPicture(rec: Rec, op: Extract<DeckOp, { kind: 'insertPicture' }>) {
  const deck = deckOf(rec)
  const slide = slideOf(deck, op.slide)
  const type = op.contentType.toLowerCase()
  const ext = PICTURE_TYPES[type]
  if (!ext) throw new PptxError(`Pictures of type ${op.contentType || 'unknown'} can't be added. Use PNG, JPEG, GIF or BMP.`)
  let box = op.box
  if (!box) {
    const size = imageSize(op.bytes, type)
    if (!size || size.width <= 0 || size.height <= 0) throw new PptxError(`${op.name || 'The picture'} could not be read as ${ext.toUpperCase()}.`)
    const k = Math.min(1, (deck.size.cx * 0.8) / (size.width * 9525), (deck.size.cy * 0.8) / (size.height * 9525))
    const cx = Math.round(size.width * 9525 * k)
    const cy = Math.round(size.height * 9525 * k)
    box = { x: Math.round((deck.size.cx - cx) / 2), y: Math.round((deck.size.cy - cy) / 2), cx, cy }
  }
  const media = freshPart(rec.pkg, '/ppt/media', 'image', ext)
  rec.put(media, op.bytes, type)
  const rId = rec.rel(slide.part, REL_TYPE.image, relativeTarget(slide.part, media))
  const doc = rec.doc(slide.part)
  const id = maxShapeId(doc) + 1
  const name = op.name.trim() || `Picture ${id - 1}`
  const el = fragment(
    doc,
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${escXml(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="${escXml(rId)}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr><a:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.round(box.cx)}" cy="${Math.round(box.cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
  )
  appendShape(spTreeOf(doc), el)
  rec.save(slide.part, doc)
  return { slide: slide.part, shape: String(id) }
}

// ---------------------------------------------------------------------------
// Text

/** The run elements of a paragraph (a:r, a:br, a:fld), in the order the model reads them. */
function runEls(pEl: Element): Element[] {
  return kids(pEl).filter((k) => k.namespaceURI === NS.a && (k.localName === 'r' || k.localName === 'br' || k.localName === 'fld'))
}

/** The text a run shows: a slide-number field shows the slide's number (as ./resolve.ts draws it). */
function shownText(runEl: Element, slide: Slide): string {
  if (runEl.localName === 'br') return '\n'
  if (runEl.localName === 'fld' && attr(runEl, 'type') === 'slidenum') return String(slide.number)
  return a(runEl, 't')?.textContent ?? ''
}

function textBodyOf(found: Found): { body: Element; paragraphs: Element[]; created: boolean } {
  if (found.node.kind !== 'sp' || found.node.connector) throw new PptxError(`${found.node.name || 'This shape'} has no text.`)
  let body = p(found.el, 'txBody')
  if (!body) {
    const doc = found.el.ownerDocument!
    body = fragment(doc, '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>')
    const ext = elementKids(found.el).find((k) => k.namespaceURI === NS.p && k.localName === 'extLst')
    found.el.insertBefore(body, ext ?? null)
    return { body, paragraphs: children(body, NS.a, 'p'), created: true }
  }
  return { body, paragraphs: children(body, NS.a, 'p'), created: false }
}

function rPrFrom(source: Element | null, doc: XMLDocument): Element | null {
  if (!source) return null
  const r = mk(doc, NS.a, 'rPr')
  for (let i = 0; i < source.attributes.length; i++) {
    const at = source.attributes[i]!
    r.setAttributeNS(at.namespaceURI, at.name, at.value)
  }
  for (let n = source.firstChild; n; n = n.nextSibling) r.appendChild(n.cloneNode(true))
  return r
}

/**
 * Replaces a text body's paragraphs with `edits`: a paragraph whose runs are
 * exactly its old runs, unchanged, stays the same element; the others are
 * rebuilt from the paragraph and runs they came from (properties cloned).
 */
function writeParagraphs(body: Element, old: Element[], edits: ParagraphEdit[], slide: Slide): boolean {
  const doc = body.ownerDocument!
  const oldRuns = old.map(runEls)
  const runEl = (ref: RunRef | null) => (ref ? (oldRuns[ref.p]?.[ref.r] ?? null) : null)
  const reused = new Set<Element>()
  const unchanged = (e: ParagraphEdit) => {
    if (e.from === null || !old[e.from]) return false
    const runs = oldRuns[e.from]!
    if (runs.length !== e.runs.length) return false
    return e.runs.every((r, i) => {
      const el = runs[i]!
      if (r.from?.p !== e.from || r.from.r !== i) return false
      return r.kind === 'break' ? el.localName === 'br' : el.localName !== 'br' && r.text === shownText(el, slide)
    })
  }
  const out: Element[] = []
  for (const e of edits.length ? edits : [{ from: old.length ? 0 : null, runs: [] }]) {
    const src = e.from !== null ? (old[e.from] ?? null) : null
    if (src && unchanged(e) && !reused.has(src)) {
      reused.add(src)
      out.push(src)
      continue
    }
    const pEl = mk(doc, NS.a, 'p')
    const pPr = src ? a(src, 'pPr') : null
    if (pPr) pEl.appendChild(pPr.cloneNode(true))
    const end = src ? a(src, 'endParaRPr') : null
    const refs = e.runs.map((r) => r.from)
    e.runs.forEach((r, i) => {
      // A run without a source takes the formatting of its neighbours in the paragraph.
      const ref = r.from ?? refs.slice(0, i).reverse().find((x) => x) ?? refs.slice(i + 1).find((x) => x) ?? null
      const source = runEl(ref)
      const props = source ? a(source, 'rPr') : null
      if (r.kind === 'break') {
        const br = mk(doc, NS.a, 'br')
        const rp = props ? (props.cloneNode(true) as Element) : rPrFrom(end, doc)
        if (rp) br.appendChild(rp)
        pEl.appendChild(br)
        return
      }
      if (r.text === '') return
      if (source?.localName === 'fld' && r.text === shownText(source, slide)) {
        pEl.appendChild(source.cloneNode(true))
        return
      }
      const run = mk(doc, NS.a, 'r')
      const rp = props ? (props.cloneNode(true) as Element) : rPrFrom(end, doc)
      if (rp) run.appendChild(rp)
      const t = mk(doc, NS.a, 't')
      setText_(t, r.text)
      run.appendChild(t)
      pEl.appendChild(run)
    })
    if (end) pEl.appendChild(end.cloneNode(true))
    out.push(pEl)
  }
  // Nothing changed: leave the part alone (saving would re-serialize it).
  if (out.length === old.length && out.every((el, i) => el === old[i])) return false
  for (const o of old) if (!reused.has(o)) body.removeChild(o)
  // Kept paragraphs move into the new order; new ones go in between.
  const ext = elementKids(body).find((k) => k.namespaceURI === NS.a && k.localName === 'extLst') ?? null
  for (const el of out) body.insertBefore(el, ext)
  return true
}

function setText(rec: Rec, op: Extract<DeckOp, { kind: 'setText' }>) {
  const found = shapeOf(rec, deckOf(rec), op.slide, op.shape)
  const { body, paragraphs, created } = textBodyOf(found)
  for (const e of op.paragraphs) for (const r of e.runs) if (r.kind === 'text' && /[\r\n]/.test(r.text)) throw new PptxError('A text run cannot contain a line break; use a break run.')
  if (writeParagraphs(body, paragraphs, op.paragraphs, found.slide) || created) rec.save(found.slide.part, found.el.ownerDocument!)
  return null
}

const cmpPos = (x: TextPos, y: TextPos) => x.p - y.p || x.r - y.r || x.o - y.o

function applyFormat(rPr: Element, f: RunFormat) {
  if (f.bold !== undefined) rPr.setAttribute('b', f.bold ? '1' : '0')
  if (f.italic !== undefined) rPr.setAttribute('i', f.italic ? '1' : '0')
  if (f.underline !== undefined) rPr.setAttribute('u', f.underline ? 'sng' : 'none')
  if (f.size !== undefined) {
    if (!Number.isInteger(f.size) || f.size < 100 || f.size > 400000) throw new PptxError(`Font size ${f.size / 100} pt is out of range (1–4000 pt).`)
    rPr.setAttribute('sz', String(f.size))
  }
  if (f.color !== undefined) {
    if (!/^[0-9a-f]{6}$/i.test(f.color)) throw new PptxError(`"${f.color}" is not a colour (RRGGBB).`)
    for (const k of elementKids(rPr)) if (k.namespaceURI === NS.a && FILLS.has(k.localName)) rPr.removeChild(k)
    const fill = mk(rPr.ownerDocument!, NS.a, 'solidFill')
    fill.appendChild(mk(rPr.ownerDocument!, NS.a, 'srgbClr', { val: f.color.toUpperCase() }))
    insertOrdered(rPr, fill, ORDER.rPr)
  }
}

/** The rPr of a run element (a:r, a:fld, a:br), created first when missing. */
function rPrOf(runEl: Element): Element {
  const found = elementKids(runEl).find((k) => k.namespaceURI === NS.a && k.localName === 'rPr')
  if (found) return found
  const r = mk(runEl.ownerDocument!, NS.a, 'rPr', { lang: 'en-US' })
  runEl.insertBefore(r, runEl.firstChild)
  return r
}

function endPropsOf(pEl: Element): Element {
  const found = elementKids(pEl).find((k) => k.namespaceURI === NS.a && k.localName === 'endParaRPr')
  if (found) return found
  const end = mk(pEl.ownerDocument!, NS.a, 'endParaRPr', { lang: 'en-US' })
  const ext = elementKids(pEl).find((k) => k.namespaceURI === NS.a && k.localName === 'extLst')
  pEl.insertBefore(end, ext ?? null)
  return end
}

function formatRuns(rec: Rec, op: Extract<DeckOp, { kind: 'formatRuns' }>) {
  const found = shapeOf(rec, deckOf(rec), op.slide, op.shape)
  const { paragraphs } = textBodyOf(found)
  const range = op.range
  if (range && cmpPos(range.start, range.end) >= 0) return null
  paragraphs.forEach((pEl, pi) => {
    const runs = runEls(pEl)
    const lens = runs.map((r) => (r.localName === 'br' ? 0 : shownText(r, found.slide).length))
    let all = true
    runs.forEach((runEl, ri) => {
      const len = lens[ri]!
      let from = 0
      let to = len
      if (range) {
        const lo = cmpPos(range.start, { p: pi, r: ri, o: 0 }) > 0 ? range.start : { p: pi, r: ri, o: 0 }
        const hi = cmpPos(range.end, { p: pi, r: ri, o: len }) < 0 ? range.end : { p: pi, r: ri, o: len }
        if (cmpPos(lo, hi) >= 0 || runEl.localName === 'br') {
          if (runEl.localName !== 'br') all = false
          return
        }
        from = lo.p === pi && lo.r === ri ? lo.o : 0
        to = hi.p === pi && hi.r === ri ? hi.o : len
        if (from > 0 || to < len) all = false
      }
      if (runEl.localName === 'br') return applyFormat(rPrOf(runEl), op.format)
      if (runEl.localName === 'fld' || (from === 0 && to === len)) return applyFormat(rPrOf(runEl), op.format)
      // Split the run so only the covered text changes.
      const text = shownText(runEl, found.slide)
      const pieces: Array<[string, boolean]> = [
        [text.slice(0, from), false],
        [text.slice(from, to), true],
        [text.slice(to), false],
      ]
      for (const [t, covered] of pieces) {
        if (!t) continue
        const piece = runEl.cloneNode(true) as Element
        setText_(a(piece, 't')!, t)
        if (covered) applyFormat(rPrOf(piece), op.format)
        pEl.insertBefore(piece, runEl)
      }
      pEl.removeChild(runEl)
    })
    const covers = !range || (cmpPos(range.start, { p: pi, r: 0, o: 0 }) <= 0 && cmpPos(range.end, { p: pi, r: Math.max(0, runs.length - 1), o: lens[runs.length - 1] ?? 0 }) >= 0)
    if (all && covers) applyFormat(endPropsOf(pEl), op.format)
  })
  rec.save(found.slide.part, found.el.ownerDocument!)
  return null
}

function findResolved(nodes: RNode[], id: string): RNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.kind === 'group') {
      const hit = findResolved(n.children, id)
      if (hit) return hit
    }
  }
  return null
}

function pPrOf(pEl: Element): Element {
  const found = elementKids(pEl).find((k) => k.namespaceURI === NS.a && k.localName === 'pPr')
  if (found) return found
  const pPr = mk(pEl.ownerDocument!, NS.a, 'pPr')
  pEl.insertBefore(pPr, pEl.firstChild)
  return pPr
}

function formatParagraphs(rec: Rec, op: Extract<DeckOp, { kind: 'formatParagraphs' }>) {
  const found = shapeOf(rec, deckOf(rec), op.slide, op.shape)
  const { paragraphs } = textBodyOf(found)
  const picked = op.paragraphs ?? paragraphs.map((_, i) => i)
  const targets = picked.map((i) => {
    const el = paragraphs[i]
    if (!el) throw new PptxError(`The text has no paragraph ${i + 1}.`)
    return { i, el }
  })
  for (const { el } of targets) {
    if (op.align !== undefined) pPrOf(el).setAttribute('algn', op.align)
    if (op.bullets !== undefined) {
      const pPr = pPrOf(el)
      for (const k of elementKids(pPr)) if (k.namespaceURI === NS.a && BULLETS.has(k.localName)) pPr.removeChild(k)
      if (!op.bullets) insertOrdered(pPr, mk(pPr.ownerDocument!, NS.a, 'buNone'), ORDER.pPr)
    }
  }
  if (op.bullets) {
    // Back to the inherited bullet; paragraphs whose style has none get a plain one.
    const deck = readDeck(rec.pkg)
    const index = deck.slides.findIndex((s) => s.part === found.slide.part)
    const rs = resolveSlide(deck, index, { editing: true })
    const node = findResolved(rs.nodes.slice(rs.ownStart), found.node.id)
    const rparas = node?.kind === 'shape' ? (node.text?.paragraphs ?? []) : []
    const withText = targets.filter(({ i }) => rparas[i]?.runs.some((r) => r.text.length > 0))
    const inherits = withText.length > 0 && withText.every(({ i }) => rparas[i]!.bullet)
    if (!inherits) {
      for (const { i, el } of targets) {
        if (rparas[i]?.bullet) continue
        const pPr = pPrOf(el)
        if (!a(pPr, 'buFont')) insertOrdered(pPr, mk(pPr.ownerDocument!, NS.a, 'buFont', { typeface: 'Arial' }), ORDER.pPr)
        insertOrdered(pPr, mk(pPr.ownerDocument!, NS.a, 'buChar', { char: '•' }), ORDER.pPr)
        if (!pPr.hasAttribute('marL') && !(rparas[i]?.marL ?? 0)) pPr.setAttribute('marL', '285750')
        if (!pPr.hasAttribute('indent') && !(rparas[i]?.indent ?? 0)) pPr.setAttribute('indent', '-285750')
      }
    }
  }
  rec.save(found.slide.part, found.el.ownerDocument!)
  return null
}

// ---------------------------------------------------------------------------
// Slides

type SlideList = { pres: string; doc: XMLDocument; list: Element; ids: Element[]; rels: Map<string, string> }

function slideList(rec: Rec): SlideList {
  const pres = presentationPart(rec.pkg)
  const doc = rec.doc(pres)
  const root = doc.documentElement as unknown as Element
  const list = ensure(root, NS.p, 'sldIdLst', ORDER.presentation)
  const rels = new Map(rec.pkg.relationships(pres).flatMap((r) => (r.part ? [[r.id, r.part] as [string, string]] : [])))
  return { pres, doc, list, ids: children(list, NS.p, 'sldId'), rels }
}

const ridOf = (el: Element) => el.getAttributeNS(NS.r, 'id') ?? ''

function sldIdOf(sl: SlideList, part: string): Element {
  const el = sl.ids.find((id) => sl.rels.get(ridOf(id)) === part)
  if (!el) throw new PptxError(`The deck has no slide ${part}.`)
  return el
}

/** p14 section lists (PowerPoint 2010+), which name slides by their sldId id. */
function sectionIds(doc: XMLDocument): Element[] {
  const out: Element[] = []
  const lists = doc.getElementsByTagNameNS(NS_P14, 'sldIdLst')
  for (let i = 0; i < lists.length; i++) for (const k of elementKids(lists[i]!)) if (k.namespaceURI === NS_P14 && k.localName === 'sldId') out.push(k)
  return out
}

/** Puts slide `id` into the section of the slide before it (or the first section when it comes first). */
function placeInSection(doc: XMLDocument, id: string, previous: string | null) {
  const entries = sectionIds(doc)
  const prev = previous === null ? null : (entries.find((e) => e.getAttribute('id') === previous) ?? null)
  let target: { list: Element; before: Node | null } | null = null
  if (prev) target = { list: prev.parentNode as Element, before: prev.nextSibling }
  else {
    const first = doc.getElementsByTagNameNS(NS_P14, 'sldIdLst')[0]
    if (first) target = { list: first, before: first.firstChild }
  }
  if (!target) return
  const el = doc.createElementNS(NS_P14, `${target.list.prefix ? `${target.list.prefix}:` : ''}sldId`)
  el.setAttribute('id', id)
  target.list.insertBefore(el, target.before)
}

function dropFromSections(doc: XMLDocument, id: string) {
  for (const e of sectionIds(doc)) if (e.getAttribute('id') === id) e.parentNode!.removeChild(e)
}

/** Adds a slide part (already in the package) to presentation.xml at position `at`. */
function listSlide(rec: Rec, part: string, at: number) {
  const sl = slideList(rec)
  const rId = rec.rel(sl.pres, REL_TYPE.slide, relativeTarget(sl.pres, part))
  const taken = sl.ids.map((e) => intAttr(e, 'id') ?? 0)
  const id = String(Math.max(255, ...taken) + 1)
  if (Number(id) >= 2147483648) throw new PptxError('The deck has no free slide id left.')
  const el = mk(sl.doc, NS.p, 'sldId', { id })
  el.setAttributeNS(NS.r, `${sl.doc.documentElement!.lookupPrefix(NS.r) ?? 'r'}:id`, rId)
  const pos = Math.max(0, Math.min(at, sl.ids.length))
  sl.list.insertBefore(el, sl.ids[pos] ?? null)
  placeInSection(sl.doc, id, pos > 0 ? (sl.ids[pos - 1]!.getAttribute('id') ?? null) : null)
  rec.save(sl.pres, sl.doc)
}

function addSlide(rec: Rec, op: Extract<DeckOp, { kind: 'addSlide' }>) {
  const deck = deckOf(rec)
  const layout = deck.layouts[op.layout]
  if (!layout) throw new PptxError(`The deck has no layout ${op.layout}.`)
  const part = freshPart(rec.pkg, '/ppt/slides', 'slide', 'xml')
  let id = 1
  const shapes: string[] = []
  for (const s of layout.shapes) {
    if (!s.ph || FURNITURE.has(s.ph.type) || s.kind !== 'sp') continue
    const phEl = p(p(p(sourceOf(s)!.el, 'nvSpPr'), 'nvPr'), 'ph')!
    const keep = ['type', 'orient', 'sz', 'idx'].flatMap((k) => (phEl.hasAttribute(k) ? [`${k}="${escXml(phEl.getAttribute(k)!)}"`] : []))
    id++
    shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escXml(s.name || `Placeholder ${id - 1}`)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${keep.join(' ')}/></p:nvPr></p:nvSpPr>` +
        `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`,
    )
  }
  rec.put(part, strToU8(`${XML_DECL}<p:sld ${NS_DECL}><p:cSld><p:spTree>${GROUP_HEAD}${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`), CT_SLIDE)
  rec.put(relsPartOf(part), strToU8(relsXml([{ id: 'rId1', type: REL_TYPE.slideLayout, target: relativeTarget(part, op.layout) }])), CT_RELS)
  listSlide(rec, part, op.at)
  return { slide: part }
}

const REMOVED_ON_COPY = new Set<string>([REL_TYPE.comments, REL_MODERN_COMMENTS])

function duplicateSlide(rec: Rec, op: Extract<DeckOp, { kind: 'duplicateSlide' }>) {
  const deck = deckOf(rec)
  const slide = slideOf(deck, op.slide)
  const part = freshPart(rec.pkg, '/ppt/slides', 'slide', 'xml')
  rec.put(part, rec.pkg.bytes(slide.part), CT_SLIDE)
  const srcRels = relsPartOf(slide.part)
  const rels = parseXml(rec.pkg.text(srcRels))
  const relEls = elementKids(rels.documentElement as unknown as Element)
  for (const r of relEls) {
    const type = r.getAttribute('Type') ?? ''
    if (REMOVED_ON_COPY.has(type)) r.parentNode!.removeChild(r)
    else if (type === REL_TYPE.notesSlide && r.getAttribute('TargetMode') !== 'External') {
      const notes = rec.pkg.relationships(slide.part).find((x) => x.id === r.getAttribute('Id'))?.part
      if (!notes || !rec.pkg.has(notes)) continue
      const copy = freshPart(rec.pkg, notes.slice(0, notes.lastIndexOf('/')), 'notesSlide', 'xml')
      rec.put(copy, rec.pkg.bytes(notes), CT_NOTES)
      const nRelsPart = relsPartOf(notes)
      if (rec.pkg.has(nRelsPart)) {
        const nRels = parseXml(rec.pkg.text(nRelsPart))
        for (const nr of elementKids(nRels.documentElement as unknown as Element)) {
          if (nr.getAttribute('Type') === REL_TYPE.slide) nr.setAttribute('Target', relativeTarget(copy, part))
        }
        rec.put(relsPartOf(copy), strToU8(serialize(nRels)), CT_RELS)
      }
      r.setAttribute('Target', relativeTarget(part, copy))
    }
  }
  rec.put(relsPartOf(part), strToU8(serialize(rels)), CT_RELS)
  const index = deck.slides.indexOf(slide)
  listSlide(rec, part, index + 1)
  return { slide: part }
}

/** Copies made here (rels of a duplicated slide) are parsed and written with the package layer's xmldom. */
function serialize(doc: XMLDocument): string {
  return new XMLSerializer().serializeToString(doc as never)
}

function deleteSlide(rec: Rec, op: Extract<DeckOp, { kind: 'deleteSlide' }>) {
  const deck = deckOf(rec)
  const slide = slideOf(deck, op.slide)
  const sl = slideList(rec)
  const el = sldIdOf(sl, slide.part)
  const rId = ridOf(el)
  sl.list.removeChild(el)
  dropFromSections(sl.doc, el.getAttribute('id') ?? '')
  // Custom shows list slides by relationship id.
  const shows = sl.doc.getElementsByTagNameNS(NS.p, 'sld')
  for (let i = shows.length - 1; i >= 0; i--) {
    const s = shows[i]!
    if (s.getAttributeNS(NS.r, 'id') === rId) s.parentNode!.removeChild(s)
  }
  rec.save(sl.pres, sl.doc)
  const presRels = relsPartOf(sl.pres)
  const relsDoc = rec.doc(presRels)
  for (const r of elementKids(relsDoc.documentElement as unknown as Element)) if (r.getAttribute('Id') === rId) r.parentNode!.removeChild(r)
  rec.save(presRels, relsDoc)
  const notes = rec.pkg.relationships(slide.part).find((r) => r.type === REL_TYPE.notesSlide && r.part && rec.pkg.has(r.part))?.part
  if (notes) {
    rec.drop(notes)
    if (rec.pkg.has(relsPartOf(notes))) rec.drop(relsPartOf(notes))
  }
  // Its comments go with it (a comment part belongs to one slide).
  for (const part of [modernCommentPart(rec.pkg, slide.part), legacyCommentPart(rec.pkg, slide.part)]) if (part) rec.drop(part)
  rec.drop(slide.part)
  if (rec.pkg.has(relsPartOf(slide.part))) rec.drop(relsPartOf(slide.part))
  return null
}

function moveSlide(rec: Rec, op: Extract<DeckOp, { kind: 'moveSlide' }>) {
  const sl = slideList(rec)
  const el = sldIdOf(sl, op.slide)
  const from = sl.ids.indexOf(el)
  const rest = sl.ids.filter((x) => x !== el)
  const to = Math.max(0, Math.min(op.to, rest.length))
  if (to === from) return null
  sl.list.insertBefore(el, rest[to] ?? null)
  const id = el.getAttribute('id') ?? ''
  if (sectionIds(sl.doc).some((e) => e.getAttribute('id') === id)) {
    dropFromSections(sl.doc, id)
    placeInSection(sl.doc, id, to > 0 ? (rest[to - 1]!.getAttribute('id') ?? null) : null)
  }
  rec.save(sl.pres, sl.doc)
  return null
}

function setHidden(rec: Rec, op: Extract<DeckOp, { kind: 'setHidden' }>) {
  const slide = slideOf(deckOf(rec), op.slide)
  const doc = rec.doc(slide.part)
  const root = doc.documentElement as unknown as Element
  if (op.hidden === (root.getAttribute('show') === '0' || root.getAttribute('show') === 'false')) return null
  if (op.hidden) root.setAttribute('show', '0')
  else root.removeAttribute('show')
  rec.save(slide.part, doc)
  return null
}

// ---------------------------------------------------------------------------
// Speaker notes

function setNotes(rec: Rec, op: Extract<DeckOp, { kind: 'setNotes' }>) {
  const deck = deckOf(rec)
  const slide = slideOf(deck, op.slide)
  const lines = op.text.replace(/\r\n?/g, '\n').split('\n')
  const empty = lines.every((l) => l === '')
  let notesPart = rec.pkg.relationships(slide.part).find((r) => r.type === REL_TYPE.notesSlide && r.part && rec.pkg.has(r.part))?.part ?? null
  if (!notesPart) {
    if (empty) return null
    notesPart = createNotes(rec, deck, slide)
  }
  const doc = rec.doc(notesPart)
  const tree = spTreeOf(doc)
  let bodySp = slide.notes ? (sourceOf(slide.notes)?.el.parentNode as Element | null) : null
  if (!bodySp || bodySp.ownerDocument !== doc) {
    const phs = doc.getElementsByTagNameNS(NS.p, 'ph')
    bodySp = null
    for (let i = 0; i < phs.length && !bodySp; i++) if (phs[i]!.getAttribute('type') === 'body') bodySp = phs[i]!.parentNode?.parentNode?.parentNode as Element | null
  }
  if (!bodySp) {
    bodySp = fragment(
      doc,
      `<p:sp><p:nvSpPr><p:cNvPr id="${maxShapeId(doc) + 1}" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`,
    )
    appendShape(tree, bodySp)
  }
  const body = p(bodySp, 'txBody') ?? (() => {
    const made = fragment(doc, '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>')
    bodySp.appendChild(made)
    return made
  })()
  const old = children(body, NS.a, 'p')
  const edits: ParagraphEdit[] = lines.map((line, i) => {
    const k = i < old.length ? i : old.length ? old.length - 1 : null
    const runs = k !== null ? runEls(old[k]!) : []
    if (i < old.length && runs.map((r) => shownText(r, slide)).join('') === line) {
      return { from: i, runs: runs.map((r, ri) => (r.localName === 'br' ? { kind: 'break', from: { p: i, r: ri } } : { kind: 'text', text: shownText(r, slide), from: { p: i, r: ri } })) }
    }
    const first = runs.findIndex((r) => r.localName === 'r')
    return { from: k, runs: line ? [{ kind: 'text', text: line, from: k !== null && first >= 0 ? { p: k, r: first } : null }] : [] }
  })
  if (writeParagraphs(body, old, edits, slide) || rec.before.has(notesPart.toLowerCase())) rec.save(notesPart, doc)
  return null
}

function createNotes(rec: Rec, deck: Deck, slide: Slide): string {
  const master = notesMasterOf(rec, deck)
  const part = freshPart(rec.pkg, '/ppt/notesSlides', 'notesSlide', 'xml')
  rec.put(
    part,
    strToU8(
      `${XML_DECL}<p:notes ${NS_DECL}><p:cSld><p:spTree>${GROUP_HEAD}` +
        `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
        `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>` +
        `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`,
    ),
    CT_NOTES,
  )
  rec.put(
    relsPartOf(part),
    strToU8(
      relsXml([
        { id: 'rId1', type: REL_TYPE.notesMaster, target: relativeTarget(part, master) },
        { id: 'rId2', type: REL_TYPE.slide, target: relativeTarget(part, slide.part) },
      ]),
    ),
    CT_RELS,
  )
  rec.rel(slide.part, REL_TYPE.notesSlide, relativeTarget(slide.part, part))
  return part
}

/** The deck's notes master, made (with its own copy of the slide theme) when the deck has none. */
function notesMasterOf(rec: Rec, deck: Deck): string {
  const pres = presentationPart(rec.pkg)
  const existing = rec.pkg.relationships(pres).find((r) => r.type === REL_TYPE.notesMaster && r.part && rec.pkg.has(r.part))
  if (existing?.part) return existing.part
  const slideMaster = Object.values(deck.masters)[0]
  if (!slideMaster) throw new PptxError('The deck has no slide master to base speaker notes on.')
  const theme = freshPart(rec.pkg, '/ppt/theme', 'theme', 'xml')
  rec.put(theme, rec.pkg.bytes(slideMaster.theme), CT_THEME)
  const part = freshPart(rec.pkg, '/ppt/notesMasters', 'notesMaster', 'xml')
  const font = (s: string) => `<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>${s}`
  rec.put(
    part,
    strToU8(
      `${XML_DECL}<p:notesMaster ${NS_DECL}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP_HEAD}` +
        `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1143000" y="685800"/><a:ext cx="4572000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>` +
        `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>` +
        `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
        `<p:notesStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>${font('')}</a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`,
    ),
    CT_NOTES_MASTER,
  )
  rec.put(relsPartOf(part), strToU8(relsXml([{ id: 'rId1', type: REL_TYPE.theme, target: relativeTarget(part, theme) }])), CT_RELS)
  const rId = rec.rel(pres, REL_TYPE.notesMaster, relativeTarget(pres, part))
  const doc = rec.doc(pres)
  const root = doc.documentElement as unknown as Element
  const list = ensure(root, NS.p, 'notesMasterIdLst', ORDER.presentation)
  const id = mk(doc, NS.p, 'notesMasterId')
  id.setAttributeNS(NS.r, `${doc.documentElement!.lookupPrefix(NS.r) ?? 'r'}:id`, rId)
  list.appendChild(id)
  rec.save(pres, doc)
  return part
}

// ---------------------------------------------------------------------------
// Comments (modern threaded comments; legacy ones are read-only, ./comments.ts)

const COMMENT_DECL = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p188="${NS_P188}"`
/** Child order of p188:cm and p188:reply. */
const CM_ORDER = ['sldMkLst', 'deMkLst', 'txMkLst', 'unknownAnchor', 'pos', 'replyLst', 'txBody', 'extLst']
/** Child order of p:sld. */
const SLD_ORDER = ['cSld', 'clrMapOvr', 'transition', 'timing', 'extLst']
/** The drawing-element moniker for each shape element. */
const MONIKER: Record<string, string> = { sp: 'spMk', pic: 'picMk', grpSp: 'grpSpMk', cxnSp: 'cxnSpMk', graphicFrame: 'graphicFrameMk' }

function commentText(text: string): string {
  const t = text.replace(/\r\n?/g, '\n')
  if (t.trim() === '') throw new PptxError('A comment needs some text.')
  const paras = t.split('\n').map((line) => (line ? `<a:p><a:r><a:rPr lang="en-US"/><a:t>${escXml(line)}</a:t></a:r></a:p>` : '<a:p><a:endParaRPr lang="en-US"/></a:p>'))
  return `<p188:txBody><a:bodyPr/><a:lstStyle/>${paras.join('')}</p188:txBody>`
}

/** Parses comment markup (a/r/p188 prefixes, others declared inline) into `doc`. */
function commentFragment(doc: XMLDocument, xml: string): Element {
  const wrap = new DOMParser().parseFromString(`<w ${COMMENT_DECL}>${xml}</w>`, 'application/xml') as unknown as XMLDocument
  const el = elementKids(wrap.documentElement!)[0]
  if (!el) throw new Error('Empty fragment.')
  return doc.importNode(el, true) as Element
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  return (words.length === 1 ? words[0]!.slice(0, 1) : `${words[0]![0]}${words.at(-1)![0]}`).toUpperCase()
}

const guid = () => `{${crypto.randomUUID().toUpperCase()}}`

function authorEls(doc: XMLDocument): Element[] {
  return elementKids(doc.documentElement as unknown as Element).filter((k) => k.namespaceURI === NS_P188 && k.localName === 'author')
}

const isMemberEl = (el: Element, member: CommentMember) => el.getAttribute('providerId') === PROVIDER && el.getAttribute('userId') === member.id

/** The member's author id in the deck's author list; the list (and the member in it) is made when missing. */
function authorIdOf(rec: Rec, member: CommentMember): string {
  if (!member.id || !member.name.trim()) throw new PptxError('A comment needs a signed-in author.')
  const pres = presentationPart(rec.pkg)
  let part = modernAuthorsPart(rec.pkg, pres)
  if (!part) {
    part = rec.pkg.has('/ppt/authors.xml') ? freshPart(rec.pkg, '/ppt', 'authors', 'xml') : '/ppt/authors.xml'
    rec.put(part, strToU8(`${XML_DECL}<p188:authorLst ${COMMENT_DECL}/>`), CT_MODERN_AUTHORS)
    rec.rel(pres, REL_MODERN_AUTHORS, relativeTarget(pres, part))
  }
  const doc = rec.doc(part)
  const found = authorEls(doc).find((el) => isMemberEl(el, member))
  if (found) return found.getAttribute('id') ?? ''
  const id = guid()
  const el = mk(doc, NS_P188, 'author', { id, name: member.name, initials: initials(member.name), userId: member.id, providerId: PROVIDER })
  doc.documentElement!.appendChild(el)
  rec.save(part, doc)
  return id
}

/** Throws unless the author with this id is the member. */
function mustOwn(rec: Rec, authorId: string, member: CommentMember, what: string) {
  const part = modernAuthorsPart(rec.pkg, presentationPart(rec.pkg))
  const el = part ? authorEls(rec.doc(part)).find((e) => e.getAttribute('id') === authorId) : undefined
  if (!el || !isMemberEl(el, member)) throw new PptxError(`You can only ${what} your own comments.`)
}

type CommentDoc = { part: string; doc: XMLDocument; root: Element }

function commentDoc(rec: Rec, slide: Slide): CommentDoc | null {
  const part = modernCommentPart(rec.pkg, slide.part)
  if (!part) return null
  const doc = rec.doc(part)
  return { part, doc, root: doc.documentElement as unknown as Element }
}

function findComment(rec: Rec, slidePart: string, id: string): CommentDoc & { slide: Slide; cm: Element } {
  const slide = slideOf(deckOf(rec), slidePart)
  const cd = commentDoc(rec, slide)
  const cm = cd ? elementKids(cd.root).find((k) => k.namespaceURI === NS_P188 && k.localName === 'cm' && k.getAttribute('id') === id) : undefined
  if (!cd || !cm) {
    if (slide.comments.threads.some((t) => t.format === 'legacy' && (t.id === id || t.replies.some((r) => r.id === id)))) throw new PptxError('Older-format comments are read-only.')
    throw new PptxError(`Slide ${slide.number} has no comment ${id}.`)
  }
  return { ...cd, slide, cm }
}

const kid = (el: Element, ns: string, name: string) => elementKids(el).find((k) => k.namespaceURI === ns && k.localName === name) ?? null

function findReply(cm: Element, id: string): Element {
  const list = kid(cm, NS_P188, 'replyLst')
  const reply = list ? elementKids(list).find((k) => k.namespaceURI === NS_P188 && k.localName === 'reply' && k.getAttribute('id') === id) : undefined
  if (!reply) throw new PptxError(`The comment has no reply ${id}.`)
  return reply
}

/** The slide's modern comment part, made (with its relationship and the slide's commentRel extension) when missing. */
function ensureCommentDoc(rec: Rec, slide: Slide, sldId: string): CommentDoc {
  const have = commentDoc(rec, slide)
  if (have) return have
  const part = freshPart(rec.pkg, '/ppt/comments', `modernComment_${Number(sldId).toString(16).toUpperCase()}_`, 'xml')
  rec.put(part, strToU8(`${XML_DECL}<p188:cmLst ${COMMENT_DECL}/>`), CT_MODERN_COMMENTS)
  const rId = rec.rel(slide.part, REL_MODERN_COMMENTS, relativeTarget(slide.part, part))
  const sdoc = rec.doc(slide.part)
  const ext = ensure(sdoc.documentElement as unknown as Element, NS.p, 'extLst', SLD_ORDER)
  const el = mk(sdoc, NS.p, 'ext', { uri: EXT_COMMENT_REL })
  const ref = sdoc.createElementNS(NS_P188, 'p188:commentRel')
  ref.setAttributeNS(NS.r, `${sdoc.documentElement!.lookupPrefix(NS.r) ?? 'r'}:id`, rId)
  el.appendChild(ref)
  ext.appendChild(el)
  rec.save(slide.part, sdoc)
  const doc = rec.doc(part)
  return { part, doc, root: doc.documentElement as unknown as Element }
}

function addComment(rec: Rec, op: Extract<DeckOp, { kind: 'addComment' }>) {
  const deck = deckOf(rec)
  const slide = slideOf(deck, op.slide)
  const body = commentText(op.text)
  if (!op.id) throw new PptxError('A new comment needs an id.')
  if (slide.comments.threads.some((t) => t.id === op.id)) throw new PptxError(`Slide ${slide.number} already has a comment ${op.id}.`)
  const sldId = sldIdOf(slideList(rec), slide.part).getAttribute('id') ?? ''
  // The slide's creation id when it has one (p14); 0 says it is not known.
  const sdoc = rec.doc(slide.part)
  const cId = sdoc.getElementsByTagNameNS(NS_P14, 'creationId')[0]?.getAttribute('val') ?? '0'
  const sldMk = `<pc:sldMk cId="${escXml(cId)}" sldId="${escXml(sldId)}"/>`
  let monikers: string
  if (op.anchor.kind === 'shape') {
    const found = shapeOf(rec, deck, slide.part, op.anchor.shape)
    const mkName = MONIKER[found.el.localName]
    if (!mkName) throw new PptxError(`Shape ${op.anchor.shape} can't take a comment.`)
    const creation = cNvPrOf(found.el)?.getElementsByTagNameNS(NS_A16, 'creationId')[0]?.getAttribute('id') ?? null
    monikers = `<ac:deMkLst xmlns:ac="${NS_AC}" xmlns:pc="${NS_PC}"><pc:docMk/>${sldMk}<ac:${mkName} id="${escXml(op.anchor.shape)}"${creation ? ` creationId="${escXml(creation)}"` : ''}/></ac:deMkLst>`
  } else monikers = `<pc:sldMkLst xmlns:pc="${NS_PC}"><pc:docMk/>${sldMk}</pc:sldMkLst>`
  const authorId = authorIdOf(rec, op.author)
  const cd = ensureCommentDoc(rec, slide, sldId)
  const pos = op.pos ? `<p188:pos x="${Math.round(op.pos.x)}" y="${Math.round(op.pos.y)}"/>` : ''
  cd.root.appendChild(commentFragment(cd.doc, `<p188:cm id="${escXml(op.id)}" authorId="${escXml(authorId)}" created="${escXml(op.created)}">${monikers}${pos}${body}</p188:cm>`))
  rec.save(cd.part, cd.doc)
  return null
}

function replyComment(rec: Rec, op: Extract<DeckOp, { kind: 'replyComment' }>) {
  const body = commentText(op.text)
  if (!op.id) throw new PptxError('A new reply needs an id.')
  const c = findComment(rec, op.slide, op.comment)
  const authorId = authorIdOf(rec, op.author)
  let list = kid(c.cm, NS_P188, 'replyLst')
  if (!list) {
    list = mk(c.doc, NS_P188, 'replyLst')
    insertOrdered(c.cm, list, CM_ORDER)
  }
  list.appendChild(commentFragment(c.doc, `<p188:reply id="${escXml(op.id)}" authorId="${escXml(authorId)}" created="${escXml(op.created)}">${body}</p188:reply>`))
  rec.save(c.part, c.doc)
  return null
}

function editComment(rec: Rec, op: Extract<DeckOp, { kind: 'editComment' }>) {
  const body = commentText(op.text)
  const c = findComment(rec, op.slide, op.comment)
  const el = op.reply === null ? c.cm : findReply(c.cm, op.reply)
  mustOwn(rec, el.getAttribute('authorId') ?? '', op.author, 'edit')
  const old = kid(el, NS_P188, 'txBody')
  const made = commentFragment(c.doc, body)
  if (old) el.replaceChild(made, old)
  else insertOrdered(el, made, CM_ORDER)
  rec.save(c.part, c.doc)
  return null
}

function setCommentStatus(rec: Rec, op: Extract<DeckOp, { kind: 'setCommentStatus' }>) {
  const c = findComment(rec, op.slide, op.comment)
  const now = c.cm.getAttribute('status') === 'resolved' ? 'resolved' : 'active'
  if (now === op.status) return null
  if (op.status === 'resolved') c.cm.setAttribute('status', 'resolved')
  else c.cm.removeAttribute('status')
  rec.save(c.part, c.doc)
  return null
}

function deleteComment(rec: Rec, op: Extract<DeckOp, { kind: 'deleteComment' }>) {
  const c = findComment(rec, op.slide, op.comment)
  const el = op.reply === null ? c.cm : findReply(c.cm, op.reply)
  mustOwn(rec, el.getAttribute('authorId') ?? '', op.author, 'delete')
  const parent = el.parentNode as Element
  parent.removeChild(el)
  if (op.reply !== null && elementKids(parent).length === 0) c.cm.removeChild(parent)
  if (elementKids(c.root).some((k) => k.namespaceURI === NS_P188 && k.localName === 'cm')) {
    rec.save(c.part, c.doc)
    return null
  }
  // The slide's last comment: the part, its relationship and the slide's reference to it go.
  const rel = rec.pkg.relationships(c.slide.part).find((r) => r.type === REL_MODERN_COMMENTS && r.part?.toLowerCase() === c.part.toLowerCase())
  rec.drop(c.part)
  if (!rel) return null
  const relsPart = relsPartOf(c.slide.part)
  const relsDoc = rec.doc(relsPart)
  for (const r of elementKids(relsDoc.documentElement as unknown as Element)) if (r.getAttribute('Id') === rel.id) r.parentNode!.removeChild(r)
  rec.save(relsPart, relsDoc)
  const sdoc = rec.doc(c.slide.part)
  const refs = sdoc.getElementsByTagNameNS(NS_P188, 'commentRel')
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!
    if (ref.getAttributeNS(NS.r, 'id') !== rel.id) continue
    const ext = ref.parentNode as Element
    const list = ext.parentNode as Element
    list.removeChild(ext)
    if (elementKids(list).length === 0) list.parentNode!.removeChild(list)
    rec.save(c.slide.part, sdoc)
  }
  return null
}
