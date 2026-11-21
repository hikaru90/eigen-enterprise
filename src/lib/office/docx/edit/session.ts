import type { Node as PMNode, Schema } from 'prosemirror-model'
import { DOMParser, XMLSerializer, type Node as XmldomNode } from '@xmldom/xmldom'
import { strToU8 } from 'fflate'
import { parseDocx, type DocxDocument } from '../model'
import { parseNumbering, type Numbering } from '../numbering'
import { NS_W14, NS_W15, NS_W16CID, parseComments, referencedComments, type CommentData } from '../comments'
import { children, descendants, intOr, NS, REL, wa, wc } from '../xml'
import { reviewParts } from './review-parts'
import { SourceRegistry } from './registry'
import { createDocxSchema, type DisplayContext } from './schema'
import { writeDocument } from './serialize'
import { toProseMirror } from './to-pm'
import { writer } from './wml'

/**
 * One Word document open for editing: the ProseMirror schema and starting
 * document built from it, and everything a save needs — the package (parts
 * nobody touches are written back byte for byte), the source DOM, new
 * hyperlink relationships, pictures and list definitions added while
 * editing.
 */

const CT_NUMBERING = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'

/** Picture types a new picture may have, with the extension its media part gets. */
export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif' }

export type ListKind = 'bullet' | 'number'

export type DocxEditSession = {
  docx: DocxDocument
  schema: Schema
  registry: SourceRegistry
  display: DisplayContext
  /** The document as opened. */
  initial: PMNode
  numbering(): Numbering
  /** The list a new bulleted or numbered list uses: an existing bullet list, else a new definition. */
  newList(kind: ListKind): string
  /** Adds a picture to the package; the image node points at its part and relationship. */
  addImage(bytes: Uint8Array, contentType: string): { part: string; rId: string }
  /** The text width of the first section (new tables span it), in points. */
  textWidthPt: number
  /** A new annotation id (w:id for a comment or a tracked change), unique in the document. */
  newId(): string
  /** A new w14:paraId / w16cid:durableId (8 hex digits below 0x80000000, unique in the document). */
  newParaId(): string
  /** The comments `doc` keeps: anchored in the body, anchored elsewhere in the file, or replies to one of those. */
  liveComments(doc: PMNode): CommentData[]
  /** The .docx with `doc` as its body, its comments and its track-changes setting. */
  serialize(doc: PMNode): Uint8Array
}

export function openForEditing(bytes: Uint8Array, opts: { imageUrl?: DisplayContext['imageUrl'] } = {}): DocxEditSession {
  const docx = parseDocx(bytes)
  const { pkg, mainPart } = docx
  const pristine = pkg.xml(mainPart)
  const mainBytes = pkg.bytes(mainPart)
  const registry = new SourceRegistry()
  let numbering = docx.numbering
  const display: DisplayContext = {
    doc: docx,
    registry,
    numbering: () => numbering,
    imageUrl: opts.imageUrl ?? (() => null),
  }
  const schema = createDocxSchema(display)
  const initial = toProseMirror(docx, schema, registry)

  // List definitions: a working copy of numbering.xml (or a new part), written on save once changed.
  const numberingRel = pkg.relationships(mainPart).find((r) => r.type === REL.numbering && !r.external && r.part && pkg.has(r.part))
  let numberingPart = numberingRel?.part ?? null
  let numberingDoc: XMLDocument | null = numberingPart ? (pkg.xml(numberingPart).cloneNode(true) as XMLDocument) : null
  let numberingDirty = false

  const section = docx.sections[0]!.props
  const textWidthPt = section.pageWidthPt - section.margin.leftPt - section.margin.rightPt
  let firstDocPrId = 1
  for (const d of descendants(pristine.documentElement!, NS.wp, 'docPr')) firstDocPrId = Math.max(firstDocPrId, (intOr(d.getAttribute('id')) ?? 0) + 1)
  const linkRels = new Map<string, string>()

  // Comments and the track-changes setting (written only when they change).
  const parsedComments = parseComments(pkg, mainPart)
  const settingsRel = pkg.relationships(mainPart).find((r) => r.type === REL.settings && !r.external && r.part && pkg.has(r.part))
  const review = reviewParts({
    pkg,
    mainPart,
    parsed: parsedComments,
    settingsPart: settingsRel?.part ?? null,
    initialTrack: docx.settings.trackRevisions,
    hasParagraphStyle: (id) => docx.styles.styles.get(id)?.type === 'paragraph',
    hasCharStyle: (id) => docx.styles.styles.get(id)?.type === 'character',
  })
  const bodyRefs = referencedComments(wc(pristine.documentElement!, 'body')!)
  /** Comments anchored outside the body (headers, notes): kept whatever the body does. */
  const elsewhere = new Set(parsedComments.list.filter((c) => !bodyRefs.has(c.id)).map((c) => c.id))

  // Ids: above every w:id the file uses; paragraph ids unlike any it has.
  let lastId = 0
  const paraIds = new Set<string>()
  const scanIds = (doc: XMLDocument) => {
    const all = doc.getElementsByTagName('*')
    for (let i = 0; i < all.length; i++) {
      const el = all[i]!
      const id = intOr(wa(el, 'id'))
      if (id !== null) lastId = Math.max(lastId, id)
      for (const ns of [NS_W14, NS_W15, NS_W16CID]) for (const a of ['paraId', 'textId', 'durableId', 'paraIdParent']) {
        const v = el.getAttributeNodeNS(ns, a)?.value
        if (v) paraIds.add(v.toUpperCase())
      }
    }
  }
  for (const part of pkg.partNames()) {
    if (!part.startsWith(mainPart.slice(0, mainPart.lastIndexOf('/') + 1)) || !part.endsWith('.xml')) continue
    scanIds(pkg.xml(part))
  }

  function numberingRoot(): Element {
    if (!numberingDoc) {
      numberingDoc = new DOMParser().parseFromString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${NS.w}"/>`, 'application/xml') as unknown as XMLDocument
    }
    return numberingDoc.documentElement!
  }

  function reparseNumbering() {
    numbering = parseNumbering(numberingDoc, docx.themeFonts, (styleId) => docx.styles.styles.get(styleId)?.pPr.numbering?.numId ?? null)
  }

  /** A new abstract definition (nine levels) and a num using it. */
  function defineList(kind: ListKind): string {
    const root = numberingRoot()
    const W = writer(numberingDoc!)
    const ids = (local: string, attr: string) => children(root).filter((c) => c.namespaceURI === NS.w && c.localName === local).map((c) => intOr(wa(c, attr)) ?? 0)
    const abstractId = String(Math.max(-1, ...ids('abstractNum', 'abstractNumId')) + 1)
    const numId = String(Math.max(0, ...ids('num', 'numId')) + 1)
    const BULLETS = ['•', '◦', '▪']
    const FORMATS = ['decimal', 'lowerLetter', 'lowerRoman']
    const levels = Array.from({ length: 9 }, (_, l) =>
      W.w('lvl', { ilvl: String(l) }, [
        W.w('start', { val: '1' }),
        W.w('numFmt', { val: kind === 'bullet' ? 'bullet' : FORMATS[l % 3]! }),
        W.w('lvlText', { val: kind === 'bullet' ? BULLETS[l % 3]! : `%${l + 1}.` }),
        W.w('lvlJc', { val: 'left' }),
        W.w('pPr', {}, [W.w('ind', { left: String(720 * (l + 1)), hanging: '360' })]),
      ]),
    )
    const abstract = W.w('abstractNum', { abstractNumId: abstractId }, [W.w('multiLevelType', { val: 'hybridMultilevel' }), ...levels])
    const num = W.w('num', { numId }, [W.w('abstractNumId', { val: abstractId })])
    // CT_Numbering: numPicBullet*, abstractNum*, num*, numIdMacAtCleanup?
    const kids = children(root)
    const firstNum = kids.find((c) => c.localName === 'num' || c.localName === 'numIdMacAtCleanup') ?? null
    root.insertBefore(abstract, firstNum)
    const cleanup = kids.find((c) => c.localName === 'numIdMacAtCleanup') ?? null
    root.insertBefore(num, cleanup)
    numberingDirty = true
    reparseNumbering()
    return numId
  }

  /** A new num restarting an existing numbered definition at 1. */
  function restartList(abstractId: string): string {
    const root = numberingRoot()
    const W = writer(numberingDoc!)
    const ids = children(root).filter((c) => c.localName === 'num').map((c) => intOr(wa(c, 'numId')) ?? 0)
    const numId = String(Math.max(0, ...ids) + 1)
    const num = W.w('num', { numId }, [W.w('abstractNumId', { val: abstractId }), W.w('lvlOverride', { ilvl: '0' }, [W.w('startOverride', { val: '1' })])])
    root.insertBefore(num, children(root).find((c) => c.localName === 'numIdMacAtCleanup') ?? null)
    numberingDirty = true
    reparseNumbering()
    return numId
  }

  function liveComments(doc: PMNode): CommentData[] {
    const anchored = new Set<string>()
    doc.descendants((n) => {
      if (n.type.name === 'comment_mark' && n.attrs.edge === 'ref') anchored.add(n.attrs.id as string)
      return true
    })
    const all = doc.attrs.comments as CommentData[]
    const byId = new Map(all.map((c) => [c.id, c]))
    const live = (c: CommentData, seen: Set<string>): boolean => {
      if (anchored.has(c.id) || elsewhere.has(c.id)) return true
      if (!c.parentId || seen.has(c.id)) return false
      const parent = byId.get(c.parentId)
      return !!parent && live(parent, new Set([...seen, c.id]))
    }
    return all.filter((c) => live(c, new Set()))
  }

  return {
    docx,
    schema,
    registry,
    display,
    initial,
    numbering: () => numbering,
    textWidthPt,
    newList(kind) {
      for (const [numId] of numbering.nums) {
        const level = numbering.level(numId, 0)
        if (!level) continue
        const isBullet = level.format === 'bullet'
        if (kind === 'bullet' && isBullet) return numId
        if (kind === 'number' && !isBullet && level.format !== 'none') {
          const abstract = numbering.abstractOf(numId)
          if (abstract) return restartList(abstract.id)
        }
      }
      return defineList(kind)
    },
    addImage(bytes, contentType) {
      const ext = IMAGE_TYPES[contentType]
      if (!ext) throw new Error(`Pictures of type ${contentType || 'unknown'} can't be added; use PNG, JPEG or GIF.`)
      const folder = mainPart.slice(0, mainPart.lastIndexOf('/'))
      let n = 1
      while (pkg.has(`${folder}/media/added-${n}.${ext}`)) n++
      const part = `${folder}/media/added-${n}.${ext}`
      pkg.setBytes(part, bytes, contentType)
      const rId = pkg.addRelationship(mainPart, REL.image, `media/added-${n}.${ext}`)
      return { part, rId }
    },
    newId: () => String(++lastId),
    newParaId() {
      for (;;) {
        const v = Math.floor(Math.random() * 0x7fffffff) + 1
        const hex = v.toString(16).toUpperCase().padStart(8, '0')
        if (!paraIds.has(hex)) {
          paraIds.add(hex)
          return hex
        }
      }
    },
    liveComments,
    serialize(doc) {
      if (doc.content.eq(initial.content)) pkg.setBytes(mainPart, mainBytes)
      else
        pkg.setXml(
          mainPart,
          writeDocument(
            {
              pkg,
              mainPart,
              reg: registry,
              pristine,
              linkRels,
              textWidthTwips: Math.round(textWidthPt * 20),
              firstDocPrId,
              newId: () => String(++lastId),
              hasCharStyle: (id) => docx.styles.styles.get(id)?.type === 'character',
            },
            doc,
          ),
        )
      if (numberingDirty && numberingDoc) {
        if (numberingPart) pkg.setXml(numberingPart, numberingDoc)
        else {
          const folder = mainPart.slice(0, mainPart.lastIndexOf('/'))
          let name = 'numbering.xml'
          for (let n = 2; pkg.has(`${folder}/${name}`); n++) name = `numbering${n}.xml`
          numberingPart = `${folder}/${name}`
          pkg.setBytes(numberingPart, strToU8(new XMLSerializer().serializeToString(numberingDoc as unknown as XmldomNode)), CT_NUMBERING)
          pkg.addRelationship(mainPart, REL.numbering, name)
        }
        numberingDirty = false
      }
      review.writeComments(liveComments(doc))
      review.writeTrackRevisions(doc.attrs.trackRevisions as boolean)
      return pkg.toBytes()
    },
  }
}

