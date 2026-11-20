import { Mark, type Node as PMNode, type Schema } from 'prosemirror-model'
import { inlineText, type Block, type DocxDocument, type Inline, type Table, type TableCell } from '../model'
import { parseParagraphProps, parseRunProps } from '../properties'
import { cellCss } from '../render'
import { symbolChar } from '../symbols'
import { attr, children, descendants, intOr, isEl, NS, onOff, wa, wc } from '../xml'
import type { SourceRegistry } from './registry'
import type { IndentTwips, ParagraphAttrs } from './schema'

/**
 * WordprocessingML → ProseMirror. Content is read from the XML itself (the
 * model's `source` elements), so every element ends up somewhere: as an
 * editable node, or carried as an opaque node with its exact XML. The model
 * supplies what the XML alone doesn't say: resolved table cell looks,
 * picture parts, field results and note numbers for the chips.
 */

type Ctx = {
  schema: Schema
  reg: SourceRegistry
  doc: DocxDocument
  /** Model inlines, table cells and tables by their source element. */
  inlines: Map<Element, Inline>
  cells: Map<Element, TableCell>
  tables: Map<Element, Table>
}

/** Elements that mark a position and show nothing (ranges, proofing state, layout caches). */
const MARKERS = new Set([
  'bookmarkEnd',
  'proofErr',
  'permStart',
  'permEnd',
  'commentRangeStart',
  'commentRangeEnd',
  'commentReference',
  'moveFromRangeStart',
  'moveFromRangeEnd',
  'moveToRangeStart',
  'moveToRangeEnd',
  'customXmlInsRangeStart',
  'customXmlInsRangeEnd',
  'customXmlDelRangeStart',
  'customXmlDelRangeEnd',
  'customXmlMoveFromRangeStart',
  'customXmlMoveFromRangeEnd',
  'customXmlMoveToRangeStart',
  'customXmlMoveToRangeEnd',
  'lastRenderedPageBreak',
  'softHyphen',
  'annotationRef',
])

const PREVIEW = 160

const qname = (el: Element) => `${el.prefix ? `${el.prefix}:` : ''}${el.localName}`

/** The text inside an element (w:t, w:delText, m:t), for a chip. */
function textInside(el: Element): string {
  const parts: string[] = []
  for (const ns of [NS.w, NS.m]) for (const t of descendants(el, ns, 't')) parts.push(t.textContent ?? '')
  for (const t of descendants(el, NS.w, 'delText')) parts.push(t.textContent ?? '')
  const text = parts.join('').replace(/\s+/g, ' ').trim()
  return text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text
}

function indexModel(doc: DocxDocument) {
  const inlines = new Map<Element, Inline>()
  const cells = new Map<Element, TableCell>()
  const tables = new Map<Element, Table>()
  const walkInlines = (list: readonly Inline[]) => {
    for (const i of list) {
      inlines.set(i.source, i)
      if (i.type === 'link' || i.type === 'field' || i.type === 'change') walkInlines(i.children)
      if (i.type === 'ruby') walkInlines(i.base)
    }
  }
  const walkBlocks = (list: readonly Block[]) => {
    for (const b of list) {
      if (b.type === 'paragraph') walkInlines(b.inlines)
      else if (b.type === 'table') {
        tables.set(b.source, b)
        for (const row of b.rows) {
          for (const c of row.cells) {
            cells.set(c.source, c)
            walkBlocks(c.blocks)
          }
        }
      }
    }
  }
  for (const s of doc.sections) walkBlocks(s.blocks)
  return { inlines, cells, tables }
}

/** The body as a ProseMirror document (the final w:sectPr stays outside: it is written back as it was). */
export function toProseMirror(doc: DocxDocument, schema: Schema, reg: SourceRegistry): PMNode {
  const root = doc.pkg.xml(doc.mainPart).documentElement!
  const body = wc(root, 'body')!
  const ctx: Ctx = { schema, reg, doc, ...indexModel(doc) }
  const blocks = readBlocks(ctx, body, true)
  return schema.node('doc', null, blocks.length > 0 ? blocks : [schema.node('paragraph')])
}

function opaqueBlock(ctx: Ctx, el: Element): PMNode {
  const ref = ctx.reg.add({ kind: 'element', el })
  const n = el.localName
  if (el.namespaceURI === NS.w && (n === 'bookmarkStart' || MARKERS.has(n))) {
    const name = wa(el, 'name')
    // Bookmarks whose names start with "_" are hidden (§17.13.6.2); the others show their name.
    if (n === 'bookmarkStart' && name && !name.startsWith('_')) return ctx.schema.node('opaque_block', { ref, kind: 'chip', label: `Bookmark: ${name}`, title: 'Bookmark' })
    return ctx.schema.node('opaque_block', { ref, kind: 'marker', label: '', title: qname(el) })
  }
  const text = textInside(el)
  const what =
    el.namespaceURI === NS.m
      ? 'Equation'
      : n === 'sdt'
        ? 'Content control'
        : n === 'altChunk'
          ? 'Imported content'
          : n === 'customXml'
            ? 'Custom XML'
            : n === 'ins' || n === 'moveTo'
              ? 'Tracked insertion'
              : n === 'del' || n === 'moveFrom'
                ? 'Tracked deletion'
                : n === 'tbl'
                  ? 'Table (kept as it is)'
                  : `Content kept as it is (${qname(el)})`
  return ctx.schema.node('opaque_block', { ref, kind: 'chip', label: text ? `${what}: ${text}` : what, title: `${what} — kept unchanged; editing it is not supported yet` })
}

function sectionLabel(sectPr: Element): string {
  const type = wa(wc(sectPr, 'type'), 'val') ?? 'nextPage'
  const what: Record<string, string> = { nextPage: 'next page', continuous: 'continuous', evenPage: 'even page', oddPage: 'odd page', nextColumn: 'next column' }
  return `Section break (${what[type] ?? type})`
}

function readBlocks(ctx: Ctx, container: Element, isBody: boolean): PMNode[] {
  const out: PMNode[] = []
  const kids = children(container)
  kids.forEach((c, i) => {
    if (c.namespaceURI === NS.w) {
      if (c.localName === 'p') {
        const { node, sectPr } = readParagraph(ctx, c)
        out.push(node)
        if (sectPr && isBody) out.push(ctx.schema.node('section_break', { ref: ctx.reg.add({ kind: 'element', el: sectPr }), label: sectionLabel(sectPr) }))
        return
      }
      if (c.localName === 'tbl') {
        out.push(editableTable(c) ? readTable(ctx, c) : opaqueBlock(ctx, c))
        return
      }
      // The final section's properties (the body's last child) and a cell's own properties are not content.
      if (isBody && c.localName === 'sectPr' && i === kids.length - 1) return
      if (!isBody && c.localName === 'tcPr') return
    }
    out.push(opaqueBlock(ctx, c))
  })
  return out
}

// ---------------------------------------------------------------- paragraphs

export function readIndent(ind: Element | null): IndentTwips | null {
  if (!ind) return null
  const out: IndentTwips = {}
  const set = (key: keyof IndentTwips, ...names: string[]) => {
    for (const n of names) {
      const v = intOr(wa(ind, n))
      if (v !== null) {
        out[key] = v
        return
      }
    }
  }
  set('start', 'start', 'left')
  set('end', 'end', 'right')
  set('firstLine', 'firstLine')
  set('hanging', 'hanging')
  return out
}

/** The editable paragraph attributes a w:pPr gives. */
export function paragraphAttrs(pPr: Element | null, ref: string | null): ParagraphAttrs {
  const numPr = wc(pPr, 'numPr')
  return {
    ref,
    styleId: wa(wc(pPr, 'pStyle'), 'val'),
    jc: wa(wc(pPr, 'jc'), 'val'),
    ind: readIndent(wc(pPr, 'ind')),
    numId: wa(wc(numPr, 'numId'), 'val'),
    ilvl: intOr(wa(wc(numPr, 'ilvl'), 'val')),
  }
}

function readParagraph(ctx: Ctx, p: Element): { node: PMNode; sectPr: Element | null } {
  const pPr = wc(p, 'pPr')
  const sectPr = wc(pPr, 'sectPr')
  const entry = { kind: 'paragraph' as const, el: p, node: null as PMNode | null, sectPr, direct: parseParagraphProps(pPr, ctx.doc.themeFonts) }
  const ref = ctx.reg.add(entry)
  const node = ctx.schema.node('paragraph', paragraphAttrs(pPr, ref), readInlines(ctx, p, null))
  entry.node = node
  // The runs and links as built: an untouched one is written back as its original XML.
  node.forEach((child) => {
    for (const m of child.marks) {
      if (m.type.name === 'run' || m.type.name === 'link') {
        const e = ctx.reg.get(m.attrs.ref as string)
        if (e && (e.kind === 'run' || e.kind === 'link')) e.nodes.push(child)
      }
    }
  })
  return { node, sectPr }
}

const contentOf = (r: Element) => children(r).filter((c) => !isEl(c, NS.w, 'rPr'))
const fldType = (el: Element) => wa(el, 'fldCharType')
const onlyFldChar = (r: Element, type: string) => {
  const c = contentOf(r)
  return c.length === 1 && isEl(c[0]!, NS.w, 'fldChar') && fldType(c[0]!) === type
}

/** The index of the run that ends the complex field beginning at `kids[i]`, or -1 when it can't be carried as one piece. */
function fieldEnd(kids: Element[], i: number): number {
  let depth = 0
  for (let j = i; j < kids.length; j++) {
    for (const f of descendants(kids[j]!, NS.w, 'fldChar')) {
      const t = fldType(f)
      if (t === 'begin') depth++
      else if (t === 'end') {
        depth--
        if (depth === 0) return isEl(kids[j]!, NS.w, 'r') && onlyFldChar(kids[j]!, 'end') ? j : -1
      }
    }
  }
  return -1
}

function fieldChip(ctx: Ctx, els: Element[], level: 'para' | 'run', marks: readonly Mark[], model: Inline | undefined, fallback: string): PMNode {
  const ref = ctx.reg.add({ kind: 'opaque', els })
  if (model?.type === 'field') {
    const result = inlineText(model.children).replace(/\s+/g, ' ').trim()
    const label = result ? (result.length > PREVIEW ? `${result.slice(0, PREVIEW)}…` : result) : `{${model.code || 'field'}}`
    return ctx.schema.node('opaque', { ref, kind: 'chip', label, title: `Field: ${model.instruction.trim()}`, level }, null, marks)
  }
  return ctx.schema.node('opaque', { ref, kind: 'chip', label: fallback, title: fallback, level }, null, marks)
}

/** Inline content of a paragraph or hyperlink. */
function readInlines(ctx: Ctx, container: Element, link: Mark | null): PMNode[] {
  const out: PMNode[] = []
  const linkMarks = link ? [link] : []
  const kids = children(container)
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]!
    if (isEl(c, NS.w, 'pPr')) continue
    if (isEl(c, NS.w, 'r')) {
      if (onlyFldChar(c, 'begin')) {
        const end = fieldEnd(kids, i)
        if (end > 0) {
          const els = kids.slice(i, end + 1)
          out.push(fieldChip(ctx, els, 'para', linkMarks, ctx.inlines.get(contentOf(c)[0]!), 'Field'))
          i = end
          continue
        }
      }
      out.push(...readRun(ctx, c, link))
      continue
    }
    if (isEl(c, NS.w, 'hyperlink')) {
      const ref = ctx.reg.add({ kind: 'link', el: c, nodes: [] })
      const model = ctx.inlines.get(c)
      const m = ctx.schema.marks.link!.create({
        href: model?.type === 'link' ? model.href : null,
        anchor: wa(c, 'anchor'),
        tooltip: wa(c, 'tooltip'),
        ref,
      })
      out.push(...readInlines(ctx, c, m))
      continue
    }
    if (isEl(c, NS.w, 'fldSimple')) {
      out.push(fieldChip(ctx, [c], 'para', linkMarks, ctx.inlines.get(c), 'Field'))
      continue
    }
    out.push(paraOpaque(ctx, c, linkMarks))
  }
  return out
}

function paraOpaque(ctx: Ctx, c: Element, marks: readonly Mark[]): PMNode {
  const ref = ctx.reg.add({ kind: 'opaque', els: [c] })
  const n = c.localName
  const isW = c.namespaceURI === NS.w
  if (isW && (MARKERS.has(n) || n === 'bookmarkStart')) {
    const name = wa(c, 'name')
    if (n === 'bookmarkStart' && name && !name.startsWith('_')) return ctx.schema.node('opaque', { ref, kind: 'chip', label: '⚑', title: `Bookmark: ${name}`, level: 'para' }, null, marks)
    return ctx.schema.node('opaque', { ref, kind: 'marker', label: '', title: qname(c), level: 'para' }, null, marks)
  }
  const text = textInside(c)
  const what =
    c.namespaceURI === NS.m
      ? 'Equation'
      : n === 'ins' || n === 'moveTo'
        ? 'Inserted'
        : n === 'del' || n === 'moveFrom'
          ? 'Deleted'
          : n === 'sdt'
            ? 'Content control'
            : n === 'smartTag' || n === 'customXml'
              ? 'Tagged text'
              : `Kept as it is (${qname(c)})`
  return ctx.schema.node('opaque', { ref, kind: 'chip', label: text || what, title: `${what}${text ? `: ${text}` : ''} — kept unchanged`, level: 'para' }, null, marks)
}

// ---------------------------------------------------------------- runs

/** The formatting marks a w:rPr sets directly (what the toolbar edits). */
export function marksOf(schema: Schema, rPr: Element | null): Mark[] {
  if (!rPr) return []
  const m = schema.marks
  const out: Mark[] = []
  const style = wa(wc(rPr, 'rStyle'), 'val')
  if (style) out.push(m.charStyle!.create({ styleId: style }))
  const fonts = wc(rPr, 'rFonts')
  const font = wa(fonts, 'ascii') ?? wa(fonts, 'hAnsi')
  if (font) out.push(m.font!.create({ name: font }))
  const sz = intOr(wa(wc(rPr, 'sz'), 'val'))
  if (sz !== null) out.push(m.size!.create({ halfPoints: sz }))
  const color = wa(wc(rPr, 'color'), 'val')
  if (color && /^[0-9a-fA-F]{6}$/.test(color)) out.push(m.color!.create({ hex: color.toLowerCase() }))
  const hl = wa(wc(rPr, 'highlight'), 'val')
  if (hl && hl !== 'none') out.push(m.highlight!.create({ val: hl }))
  if (onOff(wc(rPr, 'b')) === true) out.push(m.bold!.create())
  if (onOff(wc(rPr, 'i')) === true) out.push(m.italic!.create())
  const u = wc(rPr, 'u')
  const uVal = u ? (wa(u, 'val') ?? 'single') : null
  if (uVal && uVal !== 'none') out.push(m.underline!.create({ val: uVal }))
  if (onOff(wc(rPr, 'strike')) === true) out.push(m.strike!.create())
  const va = wa(wc(rPr, 'vertAlign'), 'val')
  if (va === 'superscript' || va === 'subscript') out.push(m.vertAlign!.create({ val: va }))
  return Mark.setFrom(out) as Mark[]
}

function readRun(ctx: Ctx, r: Element, link: Mark | null): PMNode[] {
  const { schema, reg } = ctx
  const rPr = wc(r, 'rPr')
  const content = contentOf(r)
  if (content.length === 0) {
    // An empty run: nothing to show, its XML kept in place.
    const ref = reg.add({ kind: 'opaque', els: [r] })
    return [schema.node('opaque', { ref, kind: 'marker', label: '', title: 'w:r', level: 'para' }, null, link ? [link] : [])]
  }
  const fmt = marksOf(schema, rPr)
  const runRef = reg.add({ kind: 'run', el: r, nodes: [], marks: fmt, direct: parseRunProps(rPr, ctx.doc.themeFonts) })
  const marks = Mark.setFrom([schema.marks.run!.create({ ref: runRef }), ...(link ? [link] : []), ...fmt])
  const out: PMNode[] = []
  const element = (el: Element) => reg.add({ kind: 'element', el })
  const opaque = (el: Element, kind: 'chip' | 'marker' | 'text', label: string, title: string) =>
    schema.node('opaque', { ref: reg.add({ kind: 'opaque', els: [el] }), kind, label, title, level: 'run' }, null, marks)
  for (const c of content) {
    const n = c.localName
    if (c.namespaceURI === NS.w) {
      if (n === 't') {
        const text = c.textContent ?? ''
        if (text) out.push(schema.text(text, marks))
        else out.push(opaque(c, 'marker', '', 'w:t'))
        continue
      }
      if (n === 'tab') {
        out.push(schema.node('tab', { ref: element(c) }, null, marks))
        continue
      }
      if (n === 'br' || n === 'cr') {
        const type = n === 'br' ? wa(c, 'type') : null
        if (type === 'page' || type === 'column') out.push(schema.node('page_break', { ref: element(c), kind: type }, null, marks))
        else out.push(schema.node('hard_break', { ref: element(c) }, null, marks))
        continue
      }
      if (n === 'drawing' || n === 'pict' || n === 'object') {
        out.push(picture(ctx, c, marks))
        continue
      }
      if (n === 'footnoteReference' || n === 'endnoteReference') {
        const model = ctx.inlines.get(c)
        const mark = model?.type === 'noteRef' ? model.mark : ''
        const what = n === 'footnoteReference' ? 'Footnote' : 'Endnote'
        out.push(opaque(c, 'chip', mark || '*', `${what} ${mark}`.trim()))
        continue
      }
      if (n === 'sym') {
        const code = Number.parseInt(wa(c, 'char') ?? '', 16)
        out.push(opaque(c, 'text', Number.isNaN(code) ? '?' : symbolChar(wa(c, 'font'), code).char, 'Symbol'))
        continue
      }
      if (n === 'noBreakHyphen') {
        out.push(opaque(c, 'text', '‑', 'Non-breaking hyphen'))
        continue
      }
      if (n === 'fldChar' || n === 'instrText' || n === 'delInstrText') {
        out.push(opaque(c, 'marker', '', n === 'fldChar' ? `Field ${fldType(c) ?? ''}`.trim() : `Field code: ${c.textContent ?? ''}`))
        continue
      }
      if (MARKERS.has(n)) {
        out.push(opaque(c, 'marker', '', qname(c)))
        continue
      }
    }
    if (c.namespaceURI === NS.mc && n === 'AlternateContent') {
      out.push(picture(ctx, c, marks))
      continue
    }
    const text = textInside(c)
    out.push(opaque(c, 'chip', text || `Kept as it is (${qname(c)})`, `${qname(c)} — kept unchanged`))
  }
  return out
}

/** A picture (w:drawing, VML w:pict/w:object, or one inside mc:AlternateContent): an image node when the model shows it, else a chip. */
function picture(ctx: Ctx, el: Element, marks: readonly Mark[]): PMNode {
  const candidates = [el, ...descendants(el, NS.wp, 'inline'), ...descendants(el, NS.wp, 'anchor'), ...descendants(el, NS.w, 'pict'), ...descendants(el, NS.w, 'object')]
  let model: Inline | undefined
  for (const c of candidates) {
    model = ctx.inlines.get(c)
    if (model) break
  }
  if (model?.type === 'image' && model.part) {
    const blip = descendants(el, NS.a, 'blip')[0]
    return ctx.schema.node(
      'image',
      {
        ref: ctx.reg.add({ kind: 'element', el }),
        part: model.part,
        contentType: model.contentType,
        rId: attr(blip, NS.r, 'embed'),
        widthPt: model.widthPt,
        heightPt: model.heightPt,
        alt: model.alt,
        name: '',
        floating: model.floating,
      },
      null,
      marks,
    )
  }
  const label = model?.type === 'placeholder' ? model.label : 'Drawing'
  return ctx.schema.node('opaque', { ref: ctx.reg.add({ kind: 'opaque', els: [el] }), kind: 'chip', label, title: `${label} — kept unchanged`, level: 'run' }, null, marks)
}

// ---------------------------------------------------------------- tables

/** Tables made of rows and cells only (no content controls or custom XML around them) are editable. */
function editableTable(tbl: Element): boolean {
  for (const c of children(tbl)) {
    if (c.namespaceURI !== NS.w) return false
    if (c.localName === 'tblPr' || c.localName === 'tblGrid') continue
    if (c.localName !== 'tr') return false
    for (const k of children(c)) {
      if (k.namespaceURI !== NS.w || !['tblPrEx', 'trPr', 'tc'].includes(k.localName)) return false
    }
  }
  return true
}

function readTable(ctx: Ctx, tbl: Element): PMNode {
  const { schema, reg } = ctx
  const grid = descendants(wc(tbl, 'tblGrid') ?? tbl, NS.w, 'gridCol').map((g) => intOr(wa(g, 'w')) ?? 0)
  const tableEntry = { kind: 'table' as const, el: tbl, node: null as PMNode | null, gridTwips: wc(tbl, 'tblGrid') ? grid : [] }
  const tableRef = reg.add(tableEntry)
  const rows: PMNode[] = []
  for (const tr of children(tbl).filter((c) => isEl(c, NS.w, 'tr'))) {
    const rowEntry = { kind: 'row' as const, el: tr, node: null as PMNode | null }
    const rowRef = reg.add(rowEntry)
    const cells: PMNode[] = []
    for (const tc of children(tr).filter((c) => isEl(c, NS.w, 'tc'))) {
      const model = ctx.cells.get(tc)
      const tcPr = wc(tc, 'tcPr')
      const vm = wc(tcPr, 'vMerge')
      const cellEntry = { kind: 'cell' as const, el: tc, node: null as PMNode | null, css: model ? cellCss(model, model.borders) : '' }
      const ref = reg.add(cellEntry)
      const blocks = readBlocks(ctx, tc, false)
      const cell = schema.node(
        'table_cell',
        { ref, colspan: intOr(wa(wc(tcPr, 'gridSpan'), 'val')) ?? 1, rowspan: 1, colwidth: null, vMerge: vm ? (wa(vm, 'val') === 'restart' ? 'restart' : 'continue') : null },
        blocks.length > 0 ? blocks : [schema.node('paragraph')],
      )
      cellEntry.node = cell
      cells.push(cell)
    }
    if (cells.length === 0) cells.push(schema.node('table_cell', null, [schema.node('paragraph')]))
    const row = schema.node('table_row', { ref: rowRef }, cells)
    rowEntry.node = row
    rows.push(row)
  }
  const table = schema.node('table', { ref: tableRef }, rows)
  tableEntry.node = table
  return table
}
