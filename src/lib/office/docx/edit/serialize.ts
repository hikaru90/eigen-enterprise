import type { OpcPackage } from '../../ooxml/package'
import type { SourceRegistry } from './registry'
import { Mark, type Node as PMNode } from 'prosemirror-model'
import { children, NS, REL, wa, wc } from '../xml'
import { CHANGE_MARKS, FORMAT_MARKS, formatMarks, rowWidth, type FormatMark, type IndentTwips, type MarkData, type ParagraphAttrs } from './schema'
import { paragraphAttrs } from './to-pm'
import { needsPreserve, NS_W14, PPR_ORDER, removeChildren, RPR_ORDER, setOrdered, setW, TCPR_ORDER, wChild, writer, type Writer } from './wml'

/**
 * ProseMirror → WordprocessingML, losslessly: a paragraph, run, link, table,
 * row or cell nobody touched is written back as its original XML; an edited
 * one is rebuilt from its original — same element attributes (w:rsid*,
 * w14:*), properties copied and only the changed ones rewritten, unknown
 * children kept — and only new content is written from scratch. Opaque
 * nodes put their source elements back as they were.
 *
 * The output is a fresh copy of document.xml (the source DOM is never
 * changed, so it stays the reference for every later save).
 */

export type SerializeEnv = {
  pkg: OpcPackage
  mainPart: string
  reg: SourceRegistry
  /** The document part as opened (never mutated). */
  pristine: XMLDocument
  /** Hyperlink relationships made by earlier saves: URL → relationship id. */
  linkRels: Map<string, string>
  /** Width for a new table's grid, in twips (the first section's text width). */
  textWidthTwips: number
  /** The first free wp:docPr id (drawing object ids are unique per document). */
  firstDocPrId: number
  /** A new annotation id (w:id of a revision or comment), unique in the document. */
  newId(): string
  /** Character styles the document defines (a new comment mark uses CommentReference when it exists). */
  hasCharStyle(id: string): boolean
}

type Ctx = SerializeEnv & {
  W: Writer
  /** Refs already written once: a second node with the same ref (a split paragraph, a pasted copy) is rebuilt, not reused. */
  used: Set<string>
  /** Body elements of the output document by their source element (written back in place). */
  inPlace: Map<Element, Element>
  docPrId: number
  /** Revision ids already written (an element split in two gives the second piece a new id). */
  revisionIds: Set<string>
}

const sameNodes = (a: readonly PMNode[], b: readonly PMNode[]) => a.length === b.length && a.every((n, i) => n.eq(b[i]!))

/** Serializes `doc` into a new document.xml DOM. */
export function writeDocument(env: SerializeEnv, doc: PMNode): XMLDocument {
  const out = env.pristine.cloneNode(true) as XMLDocument
  const srcBody = wc(env.pristine.documentElement!, 'body')!
  const outBody = wc(out.documentElement!, 'body')!
  const srcKids = children(srcBody)
  const outKids = children(outBody)
  const inPlace = new Map<Element, Element>(srcKids.map((k, i) => [k, outKids[i]!]))
  const ctx: Ctx = { ...env, W: writer(out), used: new Set(), inPlace, docPrId: env.firstDocPrId, revisionIds: new Set() }
  const blocks = writeBlocks(ctx, doc, true)
  const last = srcKids.at(-1)
  if (last && last.namespaceURI === NS.w && last.localName === 'sectPr') blocks.push(inPlace.get(last)!)
  reconcile(outBody, blocks)
  return out
}

/**
 * Makes `container`'s element children exactly `kids`, in order, leaving
 * elements already in place where they are (so whitespace between them, if
 * any, survives).
 */
function reconcile(container: Element, kids: Element[]) {
  const keep = new Set<Element>(kids)
  for (const c of children(container)) if (!keep.has(c)) container.removeChild(c)
  let cursor: Element | null = children(container)[0] ?? null
  for (const k of kids) {
    if (k === cursor) {
      cursor = nextElement(cursor)
      continue
    }
    container.insertBefore(k, cursor)
  }
}

function nextElement(el: Element): Element | null {
  for (let n = el.nextSibling; n; n = n.nextSibling) if (n.nodeType === 1) return n as Element
  return null
}

/** A source element as output: in place when it is a body child (first use), else a copy. */
function reuse(ctx: Ctx, el: Element): Element {
  const here = ctx.inPlace.get(el)
  if (here) {
    ctx.inPlace.delete(el)
    return here
  }
  return ctx.W.copy(el)
}

/** Claims `ref` for this node; true when it is the first node with it. */
function claim(ctx: Ctx, ref: string | null | undefined): boolean {
  if (!ref) return false
  if (ctx.used.has(ref)) return false
  ctx.used.add(ref)
  return true
}

function writeBlocks(ctx: Ctx, container: PMNode, isBody: boolean): Element[] {
  const out: Element[] = []
  const nodes: PMNode[] = []
  container.forEach((n) => nodes.push(n))
  nodes.forEach((node, i) => {
    switch (node.type.name) {
      case 'paragraph': {
        const next = nodes[i + 1]
        const sect = isBody ? (next?.type.name === 'section_break' ? sectionOf(ctx, next) : null) : 'keep'
        out.push(writeParagraph(ctx, node, sect))
        break
      }
      case 'section_break':
        // A section break needs a paragraph to carry it (§17.6.18): a new empty one when there is none before it.
        if (nodes[i - 1]?.type.name !== 'paragraph') {
          const pPr = ctx.W.w('pPr', {}, [ctx.W.copy(sectionOf(ctx, node))])
          out.push(ctx.W.w('p', {}, [pPr]))
        }
        break
      case 'table':
        out.push(writeTable(ctx, node))
        break
      case 'opaque_block': {
        const entry = ctx.reg.of(node.attrs.ref as string, 'element')
        if (!entry) throw new Error('A kept block lost its source XML.')
        out.push(reuse(ctx, entry.el))
        break
      }
      default:
        throw new Error(`Cannot write a ${node.type.name} block.`)
    }
  })
  return out
}

function sectionOf(ctx: Ctx, node: PMNode): Element {
  const entry = ctx.reg.of(node.attrs.ref as string, 'element')
  if (!entry) throw new Error('A section break lost its section properties.')
  return entry.el
}

// ---------------------------------------------------------------- paragraphs

const EMPTY_ATTRS: ParagraphAttrs = { ref: null, styleId: null, jc: null, ind: null, numId: null, ilvl: null, pChange: null, revertPPr: false, markChange: null }

/** `sect`: the w:sectPr the paragraph must carry, null for none, 'keep' (inside a table) for what it had. */
function writeParagraph(ctx: Ctx, node: PMNode, sect: Element | null | 'keep'): Element {
  const { W, reg } = ctx
  const attrs = node.attrs as ParagraphAttrs
  const entry = reg.of(attrs.ref, 'paragraph')
  const first = entry ? claim(ctx, attrs.ref) : false
  const sectPr = sect === 'keep' ? (entry?.sectPr ?? null) : sect
  if (entry && first && entry.node && node.eq(entry.node) && sectPr === entry.sectPr) return reuse(ctx, entry.el)
  const p = entry ? W.shell(entry.el) : W.w('p')
  if (entry && !first) {
    // A copy is a new paragraph: Word's paragraph ids must stay unique.
    for (const name of ['paraId', 'textId']) if (p.getAttributeNodeNS(NS_W14, name)) p.removeAttributeNS(NS_W14, name)
  }
  let origPPr = entry ? wc(entry.el, 'pPr') : null
  let was = (entry?.node?.attrs as ParagraphAttrs | undefined) ?? EMPTY_ATTRS
  const recorded = wc(wc(origPPr, 'pPrChange'), 'pPr')
  if (attrs.revertPPr && origPPr && recorded) {
    // A rejected property change: the properties it recorded, with the paragraph mark's run properties and section kept.
    const base = ctx.W.copy(recorded)
    for (const local of ['rPr', 'sectPr']) {
      const keep = wc(origPPr, local)
      if (keep) setOrdered(base, ctx.W.copy(keep), PPR_ORDER)
    }
    origPPr = base
    was = paragraphAttrs(recorded, null)
  }
  const pPr = writePPr(ctx, attrs, origPPr, was, entry?.sectPr ?? null, sectPr, first)
  if (pPr) p.appendChild(pPr)
  for (const el of writeInlines(ctx, node)) p.appendChild(el)
  return p
}

function writePPr(ctx: Ctx, a: ParagraphAttrs, orig: Element | null, was: ParagraphAttrs, sectWas: Element | null, sectPr: Element | null, first: boolean): Element | null {
  const { W } = ctx
  const pPr = orig ? W.copy(orig) : W.w('pPr')
  // Revision marks stay only on the paragraph they belong to, and only while not accepted or rejected.
  if (!a.pChange || !first) removeChildren(pPr, 'pPrChange')
  if (!a.markChange || !first) {
    const markRPr = wChild(pPr, 'rPr')
    if (markRPr) for (const n of ['ins', 'del', 'moveFrom', 'moveTo']) removeChildren(markRPr, n)
  }
  if (a.styleId !== was.styleId) {
    removeChildren(pPr, 'pStyle')
    if (a.styleId) setOrdered(pPr, W.w('pStyle', { val: a.styleId }), PPR_ORDER)
  }
  if (a.numId !== was.numId || a.ilvl !== was.ilvl) {
    removeChildren(pPr, 'numPr')
    if (a.numId !== null) {
      const kids = [...(a.ilvl !== null ? [W.w('ilvl', { val: String(a.ilvl) })] : []), W.w('numId', { val: a.numId })]
      setOrdered(pPr, W.w('numPr', {}, kids), PPR_ORDER)
    }
  }
  if (a.jc !== was.jc) {
    removeChildren(pPr, 'jc')
    if (a.jc) setOrdered(pPr, W.w('jc', { val: a.jc }), PPR_ORDER)
  }
  if (!sameIndent(a.ind, was.ind)) writeIndent(ctx, pPr, a.ind)
  if (sectPr !== sectWas) {
    removeChildren(pPr, 'sectPr')
    if (sectPr) setOrdered(pPr, W.copy(sectPr), PPR_ORDER)
  }
  if (!orig && children(pPr).length === 0) return null
  return pPr
}

const sameIndent = (a: IndentTwips | null, b: IndentTwips | null) =>
  (a?.start ?? null) === (b?.start ?? null) &&
  (a?.end ?? null) === (b?.end ?? null) &&
  (a?.firstLine ?? null) === (b?.firstLine ?? null) &&
  (a?.hanging ?? null) === (b?.hanging ?? null)

/** Rewrites w:ind's values, keeping its other attributes and the names it used (w:left or w:start). */
function writeIndent(ctx: Ctx, pPr: Element, ind: IndentTwips | null) {
  const existing = wChild(pPr, 'ind')
  if (!ind || Object.keys(ind).length === 0) {
    if (existing) pPr.removeChild(existing)
    return
  }
  const el = existing ?? ctx.W.w('ind')
  const has = (n: string) => el.getAttributeNodeNS(NS.w, n) !== null
  const put = (names: [string, string] | [string], v: number | undefined) => {
    const use = names.length === 2 && has(names[1]) && !has(names[0]) ? names[1] : names[0]
    for (const n of names) if (has(n)) el.removeAttributeNS(NS.w, n)
    if (v !== undefined) setW(el, use, String(v))
  }
  // New indents use left/right: what every Word version reads in a transitional document.
  put(existing && has('start') ? ['start', 'left'] : ['left', 'start'], ind.start)
  put(existing && has('end') ? ['end', 'right'] : ['right', 'end'], ind.end)
  put(['hanging'], ind.hanging)
  put(['firstLine'], ind.hanging !== undefined ? undefined : ind.firstLine)
  if (!existing) setOrdered(pPr, el, PPR_ORDER)
}

// ---------------------------------------------------------------- inlines

const runOf = (n: PMNode) => n.marks.find((m) => m.type.name === 'run') ?? null
const linkOf = (n: PMNode) => n.marks.find((m) => m.type.name === 'link') ?? null
const isParaLevel = (n: PMNode) => (n.type.name === 'opaque' || n.type.name === 'comment_mark') && n.attrs.level === 'para'
const fcOf = (n: PMNode) => n.marks.find((m) => m.type.name === 'formatChange') ?? null
const sameMark = (a: Mark | null, b: Mark | null) => (a === null ? b === null : b !== null && a.eq(b))

function writeInlines(ctx: Ctx, para: PMNode): Element[] {
  const nodes: PMNode[] = []
  para.forEach((n) => nodes.push(n))
  const out: Element[] = []
  let i = 0
  while (i < nodes.length) {
    const link = linkOf(nodes[i]!)
    let j = i + 1
    while (j < nodes.length && sameMark(linkOf(nodes[j]!), link)) j++
    const group = nodes.slice(i, j)
    out.push(...(link ? [writeLink(ctx, link, group)] : writeChanges(ctx, group, CHANGE_MARKS)))
    i = j
  }
  return out
}

function writeLink(ctx: Ctx, link: Mark, group: PMNode[]): Element {
  const { W, reg } = ctx
  const ref = link.attrs.ref as string | null
  const entry = reg.of(ref, 'link')
  const first = entry ? claim(ctx, ref) : false
  if (entry && first && sameNodes(group, entry.nodes)) return W.copy(entry.el)
  const h = entry ? W.shell(entry.el) : W.w('hyperlink')
  const was = entry?.nodes.map(linkOf).find((m) => m !== null)?.attrs ?? { href: null, anchor: null, tooltip: null }
  const a = link.attrs
  if (!entry || a.href !== was.href) {
    if (h.getAttributeNodeNS(NS.r, 'id')) h.removeAttributeNS(NS.r, 'id')
    if (a.href) h.setAttributeNS(NS.r, `${h.lookupPrefix(NS.r) ?? 'r'}:id`, relFor(ctx, a.href as string))
  }
  for (const [key, local] of [
    ['anchor', 'anchor'],
    ['tooltip', 'tooltip'],
  ] as const) {
    if (entry && a[key] === was[key]) continue
    if (h.getAttributeNodeNS(NS.w, local)) h.removeAttributeNS(NS.w, local)
    if (a[key]) setW(h, local, a[key] as string)
  }
  for (const el of writeChanges(ctx, group, CHANGE_MARKS)) h.appendChild(el)
  return h
}

const markOf = (n: PMNode, type: string) => n.marks.find((m) => m.type.name === type) ?? null

/** Tracked insertions around deletions around runs (a deletion of inserted text sits inside the w:ins). */
function writeChanges(ctx: Ctx, nodes: PMNode[], types: readonly string[]): Element[] {
  if (types.length === 0) return writeRuns(ctx, nodes)
  const [type, ...rest] = types
  const out: Element[] = []
  let i = 0
  while (i < nodes.length) {
    const m = markOf(nodes[i]!, type!)
    let j = i + 1
    while (j < nodes.length && sameMark(markOf(nodes[j]!, type!), m)) j++
    const group = nodes.slice(i, j)
    out.push(...(m ? [writeChange(ctx, m, group, rest)] : writeChanges(ctx, group, rest)))
    i = j
  }
  return out
}

/** A revision id for an element being written: its own, unless an earlier piece already used it. */
function revisionId(ctx: Ctx, id: string | null): string {
  const use = id && !ctx.revisionIds.has(id) ? id : ctx.newId()
  ctx.revisionIds.add(use)
  return use
}

function writeChange(ctx: Ctx, mark: Mark, group: PMNode[], rest: readonly string[]): Element {
  const { W, reg } = ctx
  const ref = mark.attrs.ref as string | null
  const entry = reg.of(ref, 'change')
  const first = entry ? claim(ctx, ref) : false
  if (entry && first && sameNodes(group, entry.nodes) && !ctx.revisionIds.has(wa(entry.el, 'id') ?? '')) {
    ctx.revisionIds.add(wa(entry.el, 'id') ?? '')
    return W.copy(entry.el)
  }
  const insertion = mark.type.name === 'insertion'
  const local = mark.attrs.move ? (insertion ? 'moveTo' : 'moveFrom') : insertion ? 'ins' : 'del'
  const el = entry ? W.shell(entry.el) : W.w(local)
  setW(el, 'id', revisionId(ctx, entry ? wa(entry.el, 'id') : (mark.attrs.id as string)))
  if (!entry) {
    if (mark.attrs.author) setW(el, 'author', mark.attrs.author as string)
    if (mark.attrs.date) setW(el, 'date', mark.attrs.date as string)
  }
  for (const k of writeChanges(ctx, group, rest)) el.appendChild(k)
  return el
}

/** The relationship id of an external hyperlink target: one the document already has, else a new one. */
function relFor(ctx: Ctx, href: string): string {
  const known = ctx.linkRels.get(href)
  if (known) return known
  const existing = ctx.pkg.relationships(ctx.mainPart).find((r) => r.type === REL.hyperlink && r.external && r.target === href)
  const id = existing?.id ?? ctx.pkg.addRelationship(ctx.mainPart, REL.hyperlink, href, { external: true })
  ctx.linkRels.set(href, id)
  return id
}

function writeRuns(ctx: Ctx, nodes: PMNode[]): Element[] {
  const out: Element[] = []
  let i = 0
  while (i < nodes.length) {
    const n = nodes[i]!
    if (isParaLevel(n)) {
      out.push(...opaqueEls(ctx, n))
      i++
      continue
    }
    const run = runOf(n)
    const fmt = formatMarks(n.marks)
    const fc = fcOf(n)
    let j = i + 1
    while (j < nodes.length && !isParaLevel(nodes[j]!) && sameMark(runOf(nodes[j]!), run) && Mark.sameSet(formatMarks(nodes[j]!.marks), fmt) && sameMark(fcOf(nodes[j]!), fc)) j++
    out.push(writeRun(ctx, run, fmt, fc, nodes.slice(i, j)))
    i = j
  }
  return out
}

function opaqueEls(ctx: Ctx, n: PMNode): Element[] {
  const entry = ctx.reg.of(n.attrs.ref as string, 'opaque')
  if (n.type.name === 'comment_mark' && (!entry || ctx.used.has(n.attrs.ref as string))) return [commentAnchor(ctx, n)]
  if (!entry) throw new Error('Kept content lost its source XML.')
  if (n.type.name === 'comment_mark') ctx.used.add(n.attrs.ref as string)
  return entry.els.map((e) => ctx.W.copy(e))
}

/** A new comment anchor (§17.13.4.3–5): range start, range end, or the reference mark in a run of its own. */
function commentAnchor(ctx: Ctx, n: PMNode): Element {
  const { W } = ctx
  const id = n.attrs.id as string
  if (n.attrs.edge === 'start') return W.w('commentRangeStart', { id })
  if (n.attrs.edge === 'end') return W.w('commentRangeEnd', { id })
  const ref = W.w('commentReference', { id })
  if (n.attrs.level === 'run') return ref
  const rPr = ctx.hasCharStyle('CommentReference') ? [W.w('rPr', {}, [W.w('rStyle', { val: 'CommentReference' })])] : []
  return W.w('r', {}, [...rPr, ref])
}

function writeRun(ctx: Ctx, run: Mark | null, fmt: readonly Mark[], fc: Mark | null, group: PMNode[]): Element {
  const { W, reg } = ctx
  const ref = (run?.attrs.ref as string | null) ?? null
  const entry = reg.of(ref, 'run')
  const first = entry ? claim(ctx, ref) : false
  if (entry && first && sameNodes(group, entry.nodes)) {
    const keep = wc(wc(entry.el, 'rPr'), 'rPrChange')
    if (keep) ctx.revisionIds.add(wa(keep, 'id') ?? '')
    return W.copy(entry.el)
  }
  const r = entry ? W.shell(entry.el) : W.w('r')
  const origRPr = entry ? wc(entry.el, 'rPr') : null
  let rPr = writeRPr(ctx, origRPr, entry?.marks ?? [], fmt)
  if (rPr) removeChildren(rPr, 'rPrChange')
  if (fc) {
    rPr ??= W.w('rPr')
    setOrdered(rPr, formatChangeEl(ctx, fc, origRPr, entry?.marks ?? []), RPR_ORDER)
  }
  // A w:rPr left empty (all its formatting removed) is left out.
  if (rPr && (children(rPr).length > 0 || rPr.attributes.length > 0)) r.appendChild(rPr)
  for (const n of group) for (const el of runContent(ctx, n)) r.appendChild(el)
  return r
}

/**
 * w:rPrChange (§17.13.5.31): the formatting before, as a whole w:rPr. One
 * from the file is kept as it was; a new one records the run's properties
 * with the formatting marks it had when tracking changed them.
 */
function formatChangeEl(ctx: Ctx, fc: Mark, origRPr: Element | null, origMarks: readonly Mark[]): Element {
  const { W } = ctx
  const source = ctx.reg.of(fc.attrs.ref as string | null, 'element')?.el ?? null
  if (source && !ctx.revisionIds.has(wa(source, 'id') ?? '')) {
    ctx.revisionIds.add(wa(source, 'id') ?? '')
    return W.copy(source)
  }
  const before = (fc.attrs.before as MarkData[]).map((d) => fc.type.schema.markFromJSON(d))
  const inner = writeRPr(ctx, origRPr, origMarks, before) ?? W.w('rPr')
  removeChildren(inner, 'rPrChange')
  const attrs: Record<string, string> = { id: revisionId(ctx, source ? null : (fc.attrs.id as string)) }
  if (fc.attrs.author) attrs.author = fc.attrs.author as string
  if (fc.attrs.date) attrs.date = fc.attrs.date as string
  return W.w('rPrChange', attrs, [inner])
}

const MARK_ELEMENTS: Record<FormatMark, string[]> = {
  charStyle: ['rStyle'],
  font: ['rFonts'],
  size: ['sz', 'szCs'],
  color: ['color'],
  highlight: ['highlight'],
  bold: ['b', 'bCs'],
  italic: ['i', 'iCs'],
  underline: ['u'],
  strike: ['strike'],
  vertAlign: ['vertAlign'],
}

/** w:rPr with only the formatting that changed rewritten (everything else in it kept as written). */
function writeRPr(ctx: Ctx, orig: Element | null, was: readonly Mark[], now: readonly Mark[]): Element | null {
  const { W } = ctx
  const rPr = orig ? W.copy(orig) : W.w('rPr')
  for (const type of FORMAT_MARKS) {
    const o = was.find((m) => m.type.name === type) ?? null
    const n = now.find((m) => m.type.name === type) ?? null
    if (sameMark(o, n)) continue
    for (const local of MARK_ELEMENTS[type]) removeChildren(rPr, local)
    if (!n) continue
    const put = (local: string, a: Record<string, string> = {}) => setOrdered(rPr, W.w(local, a), RPR_ORDER)
    switch (type) {
      case 'charStyle':
        put('rStyle', { val: n.attrs.styleId as string })
        break
      case 'font': {
        const name = n.attrs.name as string
        put('rFonts', { ascii: name, hAnsi: name, cs: name })
        break
      }
      case 'size':
        put('sz', { val: String(n.attrs.halfPoints) })
        put('szCs', { val: String(n.attrs.halfPoints) })
        break
      case 'color':
        put('color', { val: (n.attrs.hex as string).toUpperCase() })
        break
      case 'highlight':
        put('highlight', { val: n.attrs.val as string })
        break
      case 'bold':
        put('b')
        put('bCs')
        break
      case 'italic':
        put('i')
        put('iCs')
        break
      case 'underline':
        put('u', { val: n.attrs.val as string })
        break
      case 'strike':
        put('strike')
        break
      case 'vertAlign':
        put('vertAlign', { val: n.attrs.val as string })
        break
    }
  }
  if (!orig && children(rPr).length === 0) return null
  return rPr
}

function sourceEl(ctx: Ctx, n: PMNode): Element | null {
  return ctx.reg.of(n.attrs.ref as string | null, 'element')?.el ?? null
}

function runContent(ctx: Ctx, n: PMNode): Element[] {
  const { W } = ctx
  switch (n.type.name) {
    case 'text': {
      const out: Element[] = []
      // A tab or line break typed or pasted as a character is written as its element.
      const parts = (n.text ?? '').split(/(\t|\n)/)
      for (const part of parts) {
        if (part === '') continue
        if (part === '\t') out.push(W.w('tab'))
        else if (part === '\n') out.push(W.w('br'))
        else {
          // Deleted text is w:delText (§17.3.3.7).
          const t = W.w(n.marks.some((m) => m.type.name === 'deletion') ? 'delText' : 't')
          if (needsPreserve(part)) t.setAttributeNS(NS.xml, 'xml:space', 'preserve')
          t.appendChild(ctx.W.doc.createTextNode(part))
          out.push(t)
        }
      }
      return out
    }
    case 'tab': {
      const src = sourceEl(ctx, n)
      return [src ? W.copy(src) : W.w('tab')]
    }
    case 'hard_break': {
      const src = sourceEl(ctx, n)
      return [src ? W.copy(src) : W.w('br')]
    }
    case 'page_break': {
      const src = sourceEl(ctx, n)
      return [src ? W.copy(src) : W.w('br', { type: n.attrs.kind as string })]
    }
    case 'image': {
      const src = sourceEl(ctx, n)
      return [src ? W.copy(src) : drawing(ctx, n)]
    }
    case 'opaque':
    case 'comment_mark':
      return opaqueEls(ctx, n)
    default:
      throw new Error(`Cannot write a ${n.type.name} in a run.`)
  }
}

const EMU_PER_PT = 12700

/** A new inline picture (ECMA-376 Part 1 §20.4.2.8 wp:inline, §20.2 pic:pic). */
function drawing(ctx: Ctx, n: PMNode): Element {
  const { W } = ctx
  const a = n.attrs
  if (!a.rId) throw new Error('A new picture has no relationship to its media part.')
  const cx = String(Math.round((a.widthPt as number) * EMU_PER_PT))
  const cy = String(Math.round((a.heightPt as number) * EMU_PER_PT))
  const id = String(ctx.docPrId++)
  const name = (a.name as string) || `Picture ${id}`
  const wp = (local: string, at: Record<string, string> = {}, kids: Node[] = []) => W.el(NS.wp, local, at, kids)
  const da = (local: string, at: Record<string, string | [string, string]> = {}, kids: Node[] = []) => W.el(NS.a, local, at, kids)
  const pic = (local: string, at: Record<string, string> = {}, kids: Node[] = []) => W.el(NS.pic, local, at, kids)
  const graphic = da('graphic', {}, [
    da('graphicData', { uri: 'http://schemas.openxmlformats.org/drawingml/2006/picture' }, [
      pic('pic', {}, [
        pic('nvPicPr', {}, [pic('cNvPr', { id: '0', name }), pic('cNvPicPr')]),
        pic('blipFill', {}, [da('blip', { embed: [NS.r, a.rId as string] }), da('stretch', {}, [da('fillRect')])]),
        pic('spPr', {}, [da('xfrm', {}, [da('off', { x: '0', y: '0' }), da('ext', { cx, cy })]), da('prstGeom', { prst: 'rect' }, [da('avLst')])]),
      ]),
    ]),
  ])
  const inline = wp('inline', { distT: '0', distB: '0', distL: '0', distR: '0' }, [
    wp('extent', { cx, cy }),
    wp('docPr', { id, name, descr: a.alt as string }),
    wp('cNvGraphicFramePr', {}, [da('graphicFrameLocks', { noChangeAspect: '1' })]),
    graphic,
  ])
  return W.w('drawing', {}, [inline])
}

// ---------------------------------------------------------------- tables

function writeTable(ctx: Ctx, node: PMNode): Element {
  const { W, reg } = ctx
  const ref = node.attrs.ref as string | null
  const entry = reg.of(ref, 'table')
  const first = entry ? claim(ctx, ref) : false
  if (entry && first && entry.node && node.eq(entry.node)) return reuse(ctx, entry.el)
  const tbl = entry ? W.shell(entry.el) : W.w('tbl')
  let cols = 0
  node.forEach((row) => (cols = Math.max(cols, rowWidth(row))))
  const tblPr = entry ? wc(entry.el, 'tblPr') : null
  if (tblPr) tbl.appendChild(W.copy(tblPr))
  else if (!entry) tbl.appendChild(newTblPr(W))
  let widths: number[]
  if (entry && entry.gridTwips.length === cols) {
    widths = entry.gridTwips
    tbl.appendChild(W.copy(wc(entry.el, 'tblGrid')!))
  } else {
    // Columns added or removed: the grid shares the table's width out again.
    const total = entry && entry.gridTwips.length ? entry.gridTwips.reduce((x, y) => x + y, 0) : ctx.textWidthTwips
    const each = Math.max(1, Math.floor(total / Math.max(cols, 1)))
    widths = Array.from({ length: cols }, () => each)
    tbl.appendChild(W.w('tblGrid', {}, widths.map((w) => W.w('gridCol', { w: String(w) }))))
  }
  node.forEach((row) => tbl.appendChild(writeRow(ctx, row, widths)))
  return tbl
}

function newTblPr(W: Writer): Element {
  const edge = (local: string) => W.w(local, { val: 'single', sz: '4', space: '0', color: 'auto' })
  return W.w('tblPr', {}, [
    W.w('tblW', { w: '0', type: 'auto' }),
    W.w('tblBorders', {}, ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(edge)),
  ])
}

function writeRow(ctx: Ctx, row: PMNode, widths: number[]): Element {
  const { W, reg } = ctx
  const ref = row.attrs.ref as string | null
  const entry = reg.of(ref, 'row')
  const first = entry ? claim(ctx, ref) : false
  if (entry && first && entry.node && row.eq(entry.node)) return W.copy(entry.el)
  const tr = entry ? W.shell(entry.el) : W.w('tr')
  if (entry) for (const k of children(entry.el)) if (k.localName === 'tblPrEx' || k.localName === 'trPr') tr.appendChild(W.copy(k))
  let col = 0
  row.forEach((cell) => {
    const span = (cell.attrs.colspan as number) || 1
    const width = widths.slice(col, col + span).reduce((x, y) => x + y, 0)
    tr.appendChild(writeCell(ctx, cell, width))
    col += span
  })
  return tr
}

function writeCell(ctx: Ctx, cell: PMNode, widthTwips: number): Element {
  const { W, reg } = ctx
  const ref = cell.attrs.ref as string | null
  const entry = reg.of(ref, 'cell')
  const first = entry ? claim(ctx, ref) : false
  if (entry && first && entry.node && cell.eq(entry.node)) return W.copy(entry.el)
  const tc = entry ? W.shell(entry.el) : W.w('tc')
  const orig = entry ? wc(entry.el, 'tcPr') : null
  const tcPr = orig ? W.copy(orig) : W.w('tcPr')
  const was = entry?.node?.attrs ?? { colspan: 1, vMerge: null }
  if (!entry) setOrdered(tcPr, W.w('tcW', { w: String(widthTwips), type: 'dxa' }), TCPR_ORDER)
  if (cell.attrs.colspan !== was.colspan) {
    removeChildren(tcPr, 'gridSpan')
    if ((cell.attrs.colspan as number) > 1) setOrdered(tcPr, W.w('gridSpan', { val: String(cell.attrs.colspan) }), TCPR_ORDER)
  }
  if (cell.attrs.vMerge !== was.vMerge) {
    removeChildren(tcPr, 'vMerge')
    if (cell.attrs.vMerge === 'restart') setOrdered(tcPr, W.w('vMerge', { val: 'restart' }), TCPR_ORDER)
    else if (cell.attrs.vMerge === 'continue') setOrdered(tcPr, W.w('vMerge'), TCPR_ORDER)
  }
  if (orig || children(tcPr).length > 0) tc.appendChild(tcPr)
  const blocks = writeBlocks(ctx, cell, false)
  // A cell ends with a paragraph (§17.4.66).
  const last = blocks.at(-1)
  if (!last || last.localName !== 'p') blocks.push(W.w('p'))
  for (const b of blocks) tc.appendChild(b)
  return tc
}
