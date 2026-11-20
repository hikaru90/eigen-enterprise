import type { OpcPackage } from '../../ooxml/package'
import type { SourceRegistry } from './registry'
import { Mark, type Node as PMNode } from 'prosemirror-model'
import { children, NS, REL, wc } from '../xml'
import { FORMAT_MARKS, formatMarks, rowWidth, type FormatMark, type IndentTwips, type ParagraphAttrs } from './schema'
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
}

type Ctx = SerializeEnv & {
  W: Writer
  /** Refs already written once: a second node with the same ref (a split paragraph, a pasted copy) is rebuilt, not reused. */
  used: Set<string>
  /** Body elements of the output document by their source element (written back in place). */
  inPlace: Map<Element, Element>
  docPrId: number
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
  const ctx: Ctx = { ...env, W: writer(out), used: new Set(), inPlace, docPrId: env.firstDocPrId }
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

const EMPTY_ATTRS: ParagraphAttrs = { ref: null, styleId: null, jc: null, ind: null, numId: null, ilvl: null }

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
  const pPr = writePPr(ctx, attrs, entry?.el ?? null, (entry?.node?.attrs as ParagraphAttrs | undefined) ?? EMPTY_ATTRS, entry?.sectPr ?? null, sectPr)
  if (pPr) p.appendChild(pPr)
  for (const el of writeInlines(ctx, node)) p.appendChild(el)
  return p
}

function writePPr(ctx: Ctx, a: ParagraphAttrs, source: Element | null, was: ParagraphAttrs, sectWas: Element | null, sectPr: Element | null): Element | null {
  const { W } = ctx
  const orig = source ? wc(source, 'pPr') : null
  const pPr = orig ? W.copy(orig) : W.w('pPr')
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
const isParaLevel = (n: PMNode) => n.type.name === 'opaque' && n.attrs.level === 'para'
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
    out.push(...(link ? [writeLink(ctx, link, group)] : writeRuns(ctx, group)))
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
  for (const el of writeRuns(ctx, group)) h.appendChild(el)
  return h
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
    let j = i + 1
    while (j < nodes.length && !isParaLevel(nodes[j]!) && sameMark(runOf(nodes[j]!), run) && Mark.sameSet(formatMarks(nodes[j]!.marks), fmt)) j++
    out.push(writeRun(ctx, run, fmt, nodes.slice(i, j)))
    i = j
  }
  return out
}

function opaqueEls(ctx: Ctx, n: PMNode): Element[] {
  const entry = ctx.reg.of(n.attrs.ref as string, 'opaque')
  if (!entry) throw new Error('Kept content lost its source XML.')
  return entry.els.map((e) => ctx.W.copy(e))
}

function writeRun(ctx: Ctx, run: Mark | null, fmt: readonly Mark[], group: PMNode[]): Element {
  const { W, reg } = ctx
  const ref = (run?.attrs.ref as string | null) ?? null
  const entry = reg.of(ref, 'run')
  const first = entry ? claim(ctx, ref) : false
  if (entry && first && sameNodes(group, entry.nodes)) return W.copy(entry.el)
  const r = entry ? W.shell(entry.el) : W.w('r')
  const rPr = writeRPr(ctx, entry ? wc(entry.el, 'rPr') : null, entry?.marks ?? [], fmt)
  if (rPr) r.appendChild(rPr)
  for (const n of group) for (const el of runContent(ctx, n)) r.appendChild(el)
  return r
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
          const t = W.w('t')
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
