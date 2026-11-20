import { OpcError, readPackage, REL_OFFICE_DOCUMENT, type OpcPackage, type Relationship } from '../ooxml/package'
import { ListCounter, parseNumbering, type ListLabel, type Numbering } from './numbering'
import {
  EMPTY_THEME_FONTS,
  extentPt,
  mergeCell,
  mergeRun,
  parseCellProps,
  parseParagraphProps,
  parseRowProps,
  parseRunProps,
  parseSectionProps,
  parseTableProps,
  mergeTable,
  type CellProps,
  type EdgeBorders,
  type HeaderFooterRefs,
  type Margins,
  type ParagraphProps,
  type RowProps,
  type RunProps,
  type SectionProps,
  type TableProps,
  type ThemeFonts,
} from './properties'
import {
  paragraphRunBase,
  parseStyles,
  REGION_ORDER,
  resolveParagraphProps,
  resolveRunProps,
  type StyleSheet,
  type TableLayer,
  type TableRegion,
} from './styles'
import { attr, children, child, descendants, GRAPHIC, isEl, NS, onOff, REL, twipsPt, wa, wc, wcs } from './xml'

/**
 * The document model of a .docx (ECMA-376 Part 1, WordprocessingML),
 * parsed from the OPC package and independent of rendering. Every node keeps
 * `source`, the XML element it came from, so an editor can map the model to
 * its own schema and write changes back into the same DOM; the package keeps
 * every part (and every element we don't model) as it was.
 *
 * Properties come twice: `direct` (as written on the element) and `props`
 * (effective, after document defaults, styles, numbering and direct
 * formatting per §17.7.2).
 */

export class DocxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocxError'
  }
}

// ---------------------------------------------------------------- model types

export type TextInline = { type: 'text'; text: string; run: RunProps; source: Element }
export type TabInline = { type: 'tab'; run: RunProps; source: Element }
export type BreakInline = { type: 'break'; kind: 'line' | 'page' | 'column'; run: RunProps; source: Element }
export type ImageInline = {
  type: 'image'
  /** The media part; null when the relationship or part is missing (shown as a placeholder). */
  part: string | null
  contentType: string | null
  widthPt: number
  heightPt: number
  alt: string
  title: string
  /** Anchored (wp:anchor / floating VML): we place it in line with a visible note. */
  floating: boolean
  /** An embedded object (w:object) shown through its preview picture. */
  objectPreview: boolean
  run: RunProps
  source: Element
}
export type SymbolInline = { type: 'symbol'; font: string | null; code: number; run: RunProps; source: Element }
export type LinkInline = { type: 'link'; href: string | null; anchor: string | null; tooltip: string | null; children: Inline[]; source: Element }
export type FieldInline = {
  type: 'field'
  /** The field code as written (" PAGE \* MERGEFORMAT "). */
  instruction: string
  /** Its first token, upper-cased (§17.16.5): PAGE, NUMPAGES, HYPERLINK, TOC, REF, … */
  code: string
  args: string[]
  switches: Record<string, string | true>
  /** The cached result (what Word last showed); for a field spanning paragraphs, this paragraph's share. */
  children: Inline[]
  source: Element
}
export type BookmarkInline = { type: 'bookmark'; name: string; source: Element }
export type NoteRefInline = { type: 'noteRef'; kind: 'footnote' | 'endnote'; id: string; mark: string; run: RunProps; source: Element }
/** The note's own number inside its text (w:footnoteRef / w:endnoteRef). */
export type NoteMarkInline = { type: 'noteMark'; kind: 'footnote' | 'endnote'; mark: string; run: RunProps; source: Element }
export type ChangeInline = { type: 'change'; kind: 'insert' | 'delete'; author: string | null; children: Inline[]; source: Element }
export type RubyInline = { type: 'ruby'; base: Inline[]; text: Inline[]; source: Element }
export type PlaceholderInline = {
  type: 'placeholder'
  what: 'chart' | 'diagram' | 'shape' | 'equation' | 'object' | 'image' | 'content' | 'rule'
  /** What the reader sees ("Chart not shown yet"). */
  label: string
  /** Text it carries (an equation's text), if any. */
  text: string
  /** A text box's content, shown in its place. */
  blocks: Block[]
  widthPt: number | null
  heightPt: number | null
  floating: boolean
  run: RunProps
  source: Element
}

export type Inline =
  | TextInline
  | TabInline
  | BreakInline
  | ImageInline
  | SymbolInline
  | LinkInline
  | FieldInline
  | BookmarkInline
  | NoteRefInline
  | NoteMarkInline
  | ChangeInline
  | RubyInline
  | PlaceholderInline

export type ParagraphList = ListLabel & { markerRun: RunProps }

export type Paragraph = {
  type: 'paragraph'
  direct: ParagraphProps
  props: ParagraphProps
  /** The paragraph mark's effective run properties (empty-paragraph height, list marker base). */
  markRun: RunProps
  list: ParagraphList | null
  inlines: Inline[]
  source: Element
}

export type TableCell = {
  direct: CellProps
  /** Effective: table style regions, then direct. */
  props: CellProps
  /** Resolved edges after table borders and region/direct cell borders. */
  borders: EdgeBorders
  margins: Margins
  gridCol: number
  span: number
  blocks: Block[]
  source: Element
}
export type TableRow = { props: RowProps; cells: TableCell[]; source: Element }
export type Table = {
  type: 'table'
  direct: TableProps
  props: TableProps
  /** Column widths (w:tblGrid) in points. */
  grid: number[]
  rows: TableRow[]
  source: Element
}
export type BlockPlaceholder = { type: 'placeholder'; label: string; text: string; source: Element }

export type Block = Paragraph | Table | BlockPlaceholder

export type Section = {
  /** Header/footer references after inheritance from earlier sections (§17.10.5). */
  props: SectionProps
  blocks: Block[]
  source: Element | null
}

export type Note = { id: string; kind: 'footnote' | 'endnote'; mark: string; blocks: Block[]; source: Element }

export type FontInfo = { name: string; altName: string | null; family: string | null; pitch: string | null }

export type DocxSettings = { defaultTabStopPt: number; evenAndOddHeaders: boolean }

export type DocxDocument = {
  pkg: OpcPackage
  mainPart: string
  styles: StyleSheet
  numbering: Numbering
  themeFonts: ThemeFonts
  fonts: Map<string, FontInfo>
  settings: DocxSettings
  sections: Section[]
  /** Header/footer part → its content. */
  headerFooters: Map<string, Block[]>
  /** Notes in reference order (the order of their marks). */
  footnotes: Note[]
  endnotes: Note[]
  /** Things the document has that this view does not show, for a visible notice. */
  notices: string[]
}

// ---------------------------------------------------------------- parsing context

type Story = {
  part: string
  rels: Map<string, Relationship>
  counter: ListCounter
  /** Open complex fields (fldChar begin … end), innermost last. */
  fields: OpenField[]
  /** Block-level bookmarks waiting for the next paragraph. */
  pendingBookmarks: BookmarkInline[]
}

type OpenField = { instruction: string; phase: 'instr' | 'result'; children: Inline[]; source: Element }

type Ctx = {
  pkg: OpcPackage
  styles: StyleSheet
  numbering: Numbering
  theme: ThemeFonts
  notes: { footnote: Map<string, Element>; endnote: Map<string, Element> }
  noteOrder: { footnote: string[]; endnote: string[] }
  noteMarks: Map<string, string>
  flags: { changes: boolean }
}

const IGNORED = new Set([
  'pPr',
  'rPr',
  'bookmarkEnd',
  'proofErr',
  'permStart',
  'permEnd',
  'commentRangeStart',
  'commentRangeEnd',
  'commentReference',
  'annotationRef',
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
  'sdtPr',
  'sdtEndPr',
  'tblPr',
  'tblGrid',
  'trPr',
  'tcPr',
  'tblPrEx',
  'sectPr',
])

/** Markup-compatibility namespaces (§ Part 3) this reader understands well enough to take a w:Choice. */
const UNDERSTOOD = new Set<string>([NS.w, NS.r, NS.wp, NS.a, NS.pic, NS.v, NS.o, NS.m])

/** The branch of mc:AlternateContent to read (Part 3 §10.2): the first understood Choice, else Fallback, else the first Choice. */
function alternate(el: Element): Element | null {
  const choices = children(el).filter((c) => isEl(c, NS.mc, 'Choice'))
  for (const c of choices) {
    const req = (attr(c, null, 'Requires') ?? '').split(/\s+/).filter(Boolean)
    if (req.every((prefix) => UNDERSTOOD.has(c.lookupNamespaceURI(prefix) ?? ''))) return c
  }
  const fallback = child(el, NS.mc, 'Fallback')
  if (fallback && children(fallback).length > 0) return fallback
  return choices[0] ?? null
}

const label = (el: Element) => `${el.prefix ? `${el.prefix}:` : ''}${el.localName}`

// ---------------------------------------------------------------- fields

/** Splits a field code into its code, arguments and switches (§17.16.1 field syntax). */
export function parseFieldInstruction(instruction: string): Pick<FieldInline, 'code' | 'args' | 'switches'> {
  const tokens: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g
  for (let m = re.exec(instruction); m; m = re.exec(instruction)) tokens.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!)
  const [first = '', ...rest] = tokens
  const args: string[] = []
  const switches: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!
    if (/^\\[a-zA-Z*@#!]$/.test(t)) {
      const next = rest[i + 1]
      if (next !== undefined && !/^\\[a-zA-Z*@#!]$/.test(next)) {
        switches[t.slice(1)] = next
        i++
      } else switches[t.slice(1)] = true
    } else args.push(t)
  }
  return { code: first.toUpperCase(), args, switches }
}

function makeField(open: OpenField): FieldInline {
  return { type: 'field', instruction: open.instruction, ...parseFieldInstruction(open.instruction), children: open.children, source: open.source }
}

// ---------------------------------------------------------------- inline parsing

type InlineSink = { push(i: Inline): void }

class ParagraphReader {
  constructor(
    private readonly ctx: Ctx,
    private readonly story: Story,
    private readonly runBase: RunProps,
    private readonly tableLayers: readonly TableLayer[],
  ) {}

  /** Where content goes: into the innermost open field's result, nowhere while reading its instruction, else the sink. */
  private emit(sink: InlineSink, inline: Inline) {
    const top = this.story.fields.at(-1)
    if (!top) sink.push(inline)
    else if (top.phase === 'result') top.children.push(inline)
  }

  read(p: Element): Inline[] {
    const out: Inline[] = [...this.story.pendingBookmarks]
    this.story.pendingBookmarks = []
    const sink: InlineSink = { push: (i) => out.push(i) }
    this.content(p, sink, false)
    // A field still open at the paragraph end (a TOC, say) continues in the next paragraph: this paragraph keeps its share of the result.
    if (this.story.fields.length > 0) {
      const outer = this.story.fields[0]!
      if (outer.phase === 'result' && outer.children.length > 0) {
        out.push({ ...makeField(outer), children: outer.children })
        for (const f of this.story.fields) f.children = []
      }
    }
    return out
  }

  /** Children of a paragraph-level container (w:p, w:hyperlink, w:ins, w:sdtContent, …). */
  private content(el: Element, sink: InlineSink, deleted: boolean) {
    for (const c of children(el)) {
      if (c.namespaceURI === NS.mc && c.localName === 'AlternateContent') {
        const alt = alternate(c)
        if (alt) this.content(alt, sink, deleted)
        continue
      }
      if (c.namespaceURI === NS.m) {
        if (c.localName === 'oMath' || c.localName === 'oMathPara') this.emit(sink, this.equation(c))
        continue
      }
      if (c.namespaceURI !== NS.w) continue
      const n = c.localName
      if (IGNORED.has(n)) continue
      switch (n) {
        case 'r':
          this.run(c, sink, deleted)
          break
        case 'hyperlink': {
          const id = attr(c, NS.r, 'id')
          const rel = id ? this.story.rels.get(id) : undefined
          const link: LinkInline = {
            type: 'link',
            href: rel ? (rel.external ? rel.target : null) : null,
            anchor: wa(c, 'anchor'),
            tooltip: wa(c, 'tooltip'),
            children: [],
            source: c,
          }
          this.emit(sink, link)
          this.nested(c, link.children, deleted)
          break
        }
        case 'fldSimple': {
          const f: FieldInline = { type: 'field', instruction: wa(c, 'instr') ?? '', ...parseFieldInstruction(wa(c, 'instr') ?? ''), children: [], source: c }
          this.emit(sink, f)
          this.nested(c, f.children, deleted)
          break
        }
        case 'ins':
        case 'moveTo':
        case 'del':
        case 'moveFrom': {
          this.ctx.flags.changes = true
          const kind = n === 'ins' || n === 'moveTo' ? 'insert' : 'delete'
          const ch: ChangeInline = { type: 'change', kind, author: wa(c, 'author'), children: [], source: c }
          this.emit(sink, ch)
          this.nested(c, ch.children, deleted || kind === 'delete')
          break
        }
        case 'smartTag':
        case 'customXml':
        case 'bdo':
        case 'dir':
          this.content(c, sink, deleted)
          break
        case 'sdt':
          this.content(wc(c, 'sdtContent') ?? c, sink, deleted)
          break
        case 'bookmarkStart': {
          const name = wa(c, 'name')
          // _GoBack and other hidden bookmarks are anchors too; only the name matters for links.
          if (name) this.emit(sink, { type: 'bookmark', name, source: c })
          break
        }
        case 'subDoc':
          this.emit(sink, this.placeholder(c, 'content', 'Linked subdocument not shown yet', this.runBase))
          break
        default:
          this.emit(sink, this.placeholder(c, 'content', `Unsupported content (${label(c)}) not shown`, this.runBase))
      }
    }
  }

  /** Reads a container's content into `into`, with its own field scope (fields don't cross container edges). */
  private nested(el: Element, into: Inline[], deleted: boolean) {
    const saved = this.story.fields
    this.story.fields = []
    this.content(el, { push: (i) => into.push(i) }, deleted)
    for (const f of this.story.fields) if (f.phase === 'result' && f.children.length) into.push(makeField(f))
    this.story.fields = saved
  }

  private runProps(r: Element): RunProps {
    const rPr = wc(r, 'rPr')
    const direct = parseRunProps(rPr, this.ctx.theme)
    const styleId = wa(wc(rPr, 'rStyle'), 'val') ?? undefined
    return resolveRunProps(this.ctx.styles, this.runBase, styleId, direct)
  }

  private run(r: Element, sink: InlineSink, deleted: boolean) {
    const run = this.runProps(r)
    for (const c of children(r)) {
      if (c.namespaceURI === NS.mc && c.localName === 'AlternateContent') {
        const alt = alternate(c)
        if (alt) for (const a of children(alt)) this.runChild(a, run, sink, deleted)
        continue
      }
      this.runChild(c, run, sink, deleted)
    }
  }

  private runChild(c: Element, run: RunProps, sink: InlineSink, deleted: boolean) {
    if (c.namespaceURI !== NS.w) return
    const n = c.localName
    if (IGNORED.has(n)) return
    switch (n) {
      case 't':
      case 'delText':
        this.emit(sink, { type: 'text', text: c.textContent ?? '', run, source: c })
        return
      case 'instrText':
      case 'delInstrText': {
        const top = this.story.fields.at(-1)
        if (top && top.phase === 'instr') top.instruction += c.textContent ?? ''
        return
      }
      case 'fldChar': {
        const t = wa(c, 'fldCharType')
        if (t === 'begin') {
          this.story.fields.push({ instruction: '', phase: 'instr', children: [], source: c })
        } else if (t === 'separate') {
          const top = this.story.fields.at(-1)
          if (top) top.phase = 'result'
        } else if (t === 'end') {
          const done = this.story.fields.pop()
          if (done) this.emit(sink, makeField(done))
        }
        return
      }
      case 'tab':
      case 'ptab':
        this.emit(sink, { type: 'tab', run, source: c })
        return
      case 'br': {
        const t = wa(c, 'type')
        this.emit(sink, { type: 'break', kind: t === 'page' ? 'page' : t === 'column' ? 'column' : 'line', run, source: c })
        return
      }
      case 'cr':
        this.emit(sink, { type: 'break', kind: 'line', run, source: c })
        return
      case 'noBreakHyphen':
        this.emit(sink, { type: 'text', text: '‑', run, source: c })
        return
      case 'softHyphen':
        this.emit(sink, { type: 'text', text: '­', run, source: c })
        return
      case 'sym': {
        const code = Number.parseInt(wa(c, 'char') ?? '', 16)
        if (!Number.isNaN(code)) this.emit(sink, { type: 'symbol', font: wa(c, 'font'), code, run, source: c })
        return
      }
      case 'drawing':
        for (const d of children(c)) {
          if (d.namespaceURI === NS.wp && (d.localName === 'inline' || d.localName === 'anchor')) this.emit(sink, this.drawing(d, run))
        }
        return
      case 'pict':
        this.emit(sink, this.vml(c, run, false))
        return
      case 'object':
        this.emit(sink, this.vml(c, run, true))
        return
      case 'footnoteReference':
      case 'endnoteReference': {
        const kind = n === 'footnoteReference' ? 'footnote' : 'endnote'
        const id = wa(c, 'id') ?? ''
        const custom = wa(c, 'customMarkFollows')
        const order = this.ctx.noteOrder[kind]
        if (!order.includes(id)) order.push(id)
        const mark = custom === '1' || custom === 'true' ? '' : String(order.indexOf(id) + 1)
        this.ctx.noteMarks.set(`${kind}:${id}`, mark)
        this.emit(sink, { type: 'noteRef', kind, id, mark, run, source: c })
        return
      }
      case 'footnoteRef':
      case 'endnoteRef': {
        const kind = n === 'footnoteRef' ? 'footnote' : 'endnote'
        this.emit(sink, { type: 'noteMark', kind, mark: '', run, source: c })
        return
      }
      case 'separator':
      case 'continuationSeparator':
        this.emit(sink, this.placeholder(c, 'rule', '', run))
        return
      case 'ruby': {
        const base: Inline[] = []
        const text: Inline[] = []
        this.nested(wc(c, 'rubyBase') ?? c, base, deleted)
        this.nested(wc(c, 'rt') ?? c, text, deleted)
        this.emit(sink, { type: 'ruby', base, text, source: c })
        return
      }
      default:
        this.emit(sink, this.placeholder(c, 'content', `Unsupported content (${label(c)}) not shown`, run))
    }
  }

  private placeholder(source: Element, what: PlaceholderInline['what'], text: string, run: RunProps, extra: Partial<PlaceholderInline> = {}): PlaceholderInline {
    return { type: 'placeholder', what, label: text, text: '', blocks: [], widthPt: null, heightPt: null, floating: false, run, source, ...extra }
  }

  private equation(el: Element): PlaceholderInline {
    const text = descendants(el, NS.m, 't')
      .map((t) => t.textContent ?? '')
      .join('')
    return this.placeholder(el, 'equation', 'Equation shown as plain text', this.runBase, { text })
  }

  /** Text boxes (w:txbxContent) anywhere inside a shape: their paragraphs, read as a nested story. */
  private textBoxes(el: Element): Block[] {
    const out: Block[] = []
    for (const box of descendants(el, NS.w, 'txbxContent')) out.push(...readBlocks(this.ctx, this.story, box, this.tableLayers))
    return out
  }

  private drawing(d: Element, run: RunProps): Inline {
    const floating = d.localName === 'anchor'
    const size = extentPt(child(d, NS.wp, 'extent'))
    const docPr = child(d, NS.wp, 'docPr')
    const alt = attr(docPr, null, 'descr') ?? ''
    const title = attr(docPr, null, 'title') ?? ''
    const data = child(child(d, NS.a, 'graphic'), NS.a, 'graphicData')
    const uri = attr(data, null, 'uri')
    const dims = { widthPt: size?.widthPt ?? null, heightPt: size?.heightPt ?? null, floating }
    if (uri === GRAPHIC.picture) {
      const pic = child(data, NS.pic, 'pic')
      const blip = child(child(pic, NS.pic, 'blipFill'), NS.a, 'blip')
      const embed = attr(blip, NS.r, 'embed')
      if (!embed && attr(blip, NS.r, 'link')) return this.placeholder(d, 'image', 'Linked picture not shown', run, dims)
      return this.image(d, embed, size, alt, title, floating, false, run)
    }
    if (uri === GRAPHIC.chart) return this.placeholder(d, 'chart', 'Chart not shown yet', run, dims)
    if (uri === GRAPHIC.diagram) return this.placeholder(d, 'diagram', 'Diagram not shown yet', run, dims)
    const blocks = this.textBoxes(d)
    if (uri === GRAPHIC.shape || uri === GRAPHIC.group || uri === GRAPHIC.canvas) {
      return this.placeholder(d, 'shape', blocks.length ? 'Shape shown as its text' : 'Shape not shown yet', run, { ...dims, blocks })
    }
    return this.placeholder(d, 'object', 'Embedded content not shown yet', run, { ...dims, blocks })
  }

  private image(
    source: Element,
    rid: string | null,
    size: { widthPt: number; heightPt: number } | null,
    alt: string,
    title: string,
    floating: boolean,
    objectPreview: boolean,
    run: RunProps,
  ): ImageInline {
    const rel = rid ? this.story.rels.get(rid) : undefined
    const part = rel && !rel.external && rel.part && this.ctx.pkg.has(rel.part) ? rel.part : null
    let contentType: string | null = null
    if (part) {
      try {
        contentType = this.ctx.pkg.contentType(part)
      } catch {
        contentType = null
      }
    }
    return {
      type: 'image',
      part,
      contentType,
      widthPt: size?.widthPt ?? 0,
      heightPt: size?.heightPt ?? 0,
      alt,
      title,
      floating,
      objectPreview,
      run,
      source,
    }
  }

  /** VML (w:pict, w:object): pictures through v:imagedata, horizontal rules, text boxes; anything else a placeholder. */
  private vml(el: Element, run: RunProps, isObject: boolean): Inline {
    const shape = descendants(el, NS.v, 'shape')[0] ?? descendants(el, NS.v, 'rect')[0] ?? null
    const style = parseVmlStyle(attr(shape, null, 'style') ?? '')
    const size = style.widthPt !== null && style.heightPt !== null ? { widthPt: style.widthPt, heightPt: style.heightPt } : null
    const floating = style.position === 'absolute'
    const imagedata = descendants(el, NS.v, 'imagedata')[0]
    if (imagedata) {
      const rid = attr(imagedata, NS.r, 'id') ?? attr(imagedata, NS.r, 'pict')
      const alt = attr(shape, null, 'alt') ?? attr(imagedata, NS.o, 'title') ?? ''
      return this.image(el, rid, size, alt, '', floating, isObject, run)
    }
    // o:hr declares a horizontal rule (VML extension, Part 4 §19.1.2.x).
    const hr = descendants(el, NS.v, 'rect').find((r) => attr(r, NS.o, 'hr') === 't')
    if (hr) return this.placeholder(el, 'rule', '', run)
    const blocks = this.textBoxes(el)
    if (isObject) return this.placeholder(el, 'object', 'Embedded object not shown yet', run, { ...dims(size), floating })
    return this.placeholder(el, 'shape', blocks.length ? 'Shape shown as its text' : 'Shape not shown yet', run, { ...dims(size), floating, blocks })
  }
}

const dims = (size: { widthPt: number; heightPt: number } | null) => ({ widthPt: size?.widthPt ?? null, heightPt: size?.heightPt ?? null })

/** The VML style attribute (CSS-like declarations) — width/height/position only. */
export function parseVmlStyle(style: string): { widthPt: number | null; heightPt: number | null; position: string | null } {
  const decl = new Map<string, string>()
  for (const part of style.split(';')) {
    const i = part.indexOf(':')
    if (i > 0) decl.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim())
  }
  const len = (v: string | undefined) => {
    if (!v) return null
    const m = /^(-?\d+(?:\.\d+)?)(pt|in|cm|mm|px|pc)?$/.exec(v)
    if (!m) return null
    const n = Number(m[1])
    const unit = m[2] ?? 'px'
    return unit === 'pt' ? n : unit === 'in' ? n * 72 : unit === 'cm' ? (n * 72) / 2.54 : unit === 'mm' ? (n * 72) / 25.4 : unit === 'pc' ? n * 12 : n * 0.75
  }
  return { widthPt: len(decl.get('width')), heightPt: len(decl.get('height')), position: decl.get('position') ?? null }
}

// ---------------------------------------------------------------- blocks

function readParagraph(ctx: Ctx, story: Story, el: Element, tableLayers: readonly TableLayer[]): Paragraph {
  const direct = parseParagraphProps(wc(el, 'pPr'), ctx.theme)
  // The numbering a paragraph uses: direct w:numPr, else its style's (numId 0 switches it off).
  const styled = ctx.styles.paragraphStyle(direct.styleId)
  const num = direct.numbering?.numId ? direct.numbering : styled.pPr.numbering
  const ilvl = direct.numbering?.ilvl ?? num?.ilvl ?? 0
  const level = num && num.numId !== '0' ? ctx.numbering.level(num.numId, ilvl) : null
  const props = resolveParagraphProps(ctx.styles, direct, tableLayers, level?.pPr ?? null)
  const runBase = paragraphRunBase(ctx.styles, direct.styleId, tableLayers)
  const markRun = mergeRun(runBase, direct.markRun ?? {})
  let list: ParagraphList | null = null
  if (num && level) {
    const l = story.counter.next(num.numId, ilvl)
    // The label takes the paragraph mark's formatting, then the level's own w:rPr (§17.9.24).
    if (l) list = { ...l, markerRun: mergeRun(markRun, level.rPr) }
  }
  const reader = new ParagraphReader(ctx, story, runBase, tableLayers)
  return { type: 'paragraph', direct, props, markRun, list, inlines: reader.read(el), source: el }
}

function regionsFor(
  look: NonNullable<TableProps['look']>,
  r: number,
  rows: number,
  c: number,
  cols: number,
  rowBand: number,
  colBand: number,
): TableRegion[] {
  const out: TableRegion[] = ['wholeTable']
  const firstRow = look.firstRow && r === 0
  const lastRow = look.lastRow && r === rows - 1
  const firstCol = look.firstColumn && c === 0
  const lastCol = look.lastColumn && c === cols - 1
  if (!look.noVBand && !firstCol && !lastCol) {
    const ci = c - (look.firstColumn ? 1 : 0)
    out.push(Math.floor(ci / colBand) % 2 === 0 ? 'band1Vert' : 'band2Vert')
  }
  if (!look.noHBand && !firstRow && !lastRow) {
    const ri = r - (look.firstRow ? 1 : 0)
    out.push(Math.floor(ri / rowBand) % 2 === 0 ? 'band1Horz' : 'band2Horz')
  }
  if (firstCol) out.push('firstCol')
  if (lastCol) out.push('lastCol')
  if (firstRow) out.push('firstRow')
  if (lastRow) out.push('lastRow')
  if (firstRow && firstCol) out.push('nwCell')
  if (firstRow && lastCol) out.push('neCell')
  if (lastRow && firstCol) out.push('swCell')
  if (lastRow && lastCol) out.push('seCell')
  return REGION_ORDER.filter((x) => out.includes(x))
}

const DEFAULT_LOOK = { firstRow: true, lastRow: false, firstColumn: true, lastColumn: false, noHBand: false, noVBand: true }

function readTable(ctx: Ctx, story: Story, el: Element, outerLayers: readonly TableLayer[]): Table {
  void outerLayers
  const direct = parseTableProps(wc(el, 'tblPr'))
  const style = ctx.styles.tableStyle(direct.styleId)
  const props = mergeTable(style.formatting.tblPr, direct)
  const grid = wcs(wc(el, 'tblGrid'), 'gridCol').map((g) => twipsPt(wa(g, 'w')) ?? 0)
  const look = props.look ?? DEFAULT_LOOK
  const rowEls = rowsOf(el)
  const cols = Math.max(grid.length, 1)
  const rows: TableRow[] = rowEls.map((tr, ri) => {
    const rowProps = parseRowProps(wc(tr, 'trPr'), tr)
    let col = rowProps.gridBefore ?? 0
    const cells = cellsOf(tr).map((tc) => {
      const cellDirect = parseCellProps(wc(tc, 'tcPr'))
      const span = cellDirect.span ?? 1
      const regions = regionsFor(look, ri, rowEls.length, col, cols, props.rowBandSize ?? 1, props.colBandSize ?? 1)
      const formatting = regions.map((r) => (r === 'wholeTable' ? style.formatting : style.regions[r])).filter((f) => f !== undefined)
      let cellProps: CellProps = {}
      for (const f of formatting) cellProps = mergeCell(cellProps, f.tcPr)
      cellProps = mergeCell(cellProps, cellDirect)
      const layers: TableLayer[] = formatting.map((f) => ({ pPr: f.pPr, rPr: f.rPr }))
      const cell: TableCell = {
        direct: cellDirect,
        props: cellProps,
        borders: cellBorders(props, formatting.map((f) => f.tblPr), cellProps, ri, rowEls.length, col, span, cols),
        margins: { ...props.cellMargins, ...cellProps.margins },
        gridCol: col,
        span,
        blocks: readBlocks(ctx, story, tc, layers),
        source: tc,
      }
      col += span
      return cell
    })
    return { props: rowProps, cells, source: tr }
  })
  return { type: 'table', direct, props, grid, rows, source: el }
}

/** Rows, through content controls and custom XML around them. */
function rowsOf(tbl: Element): Element[] {
  const out: Element[] = []
  for (const c of children(tbl)) {
    if (isEl(c, NS.w, 'tr')) out.push(c)
    else if (isEl(c, NS.w, 'sdt')) out.push(...rowsOf(wc(c, 'sdtContent') ?? c))
    else if (isEl(c, NS.w, 'customXml')) out.push(...rowsOf(c))
  }
  return out
}

function cellsOf(tr: Element): Element[] {
  const out: Element[] = []
  for (const c of children(tr)) {
    if (isEl(c, NS.w, 'tc')) out.push(c)
    else if (isEl(c, NS.w, 'sdt')) out.push(...cellsOf(wc(c, 'sdtContent') ?? c))
    else if (isEl(c, NS.w, 'customXml')) out.push(...cellsOf(c))
  }
  return out
}

/** A cell's edges: its own (style region, then direct) borders, else the table's outer or inside borders by position. */
function cellBorders(
  table: TableProps,
  regionTables: TableProps[],
  cell: CellProps,
  r: number,
  rows: number,
  c: number,
  span: number,
  cols: number,
): EdgeBorders {
  let tb: EdgeBorders = { ...table.borders }
  for (const t of regionTables) tb = { ...tb, ...t.borders }
  const own = cell.borders ?? {}
  const pick = (edge: 'top' | 'bottom' | 'start' | 'end', outer: boolean, inside: 'insideH' | 'insideV') => own[edge] ?? (outer ? tb[edge] : tb[inside])
  const out: EdgeBorders = {}
  const top = pick('top', r === 0, 'insideH')
  const bottom = pick('bottom', r === rows - 1, 'insideH')
  const start = pick('start', c === 0, 'insideV')
  const end = pick('end', c + span >= cols, 'insideV')
  if (top) out.top = top
  if (bottom) out.bottom = bottom
  if (start) out.start = start
  if (end) out.end = end
  return out
}

/** Block-level content of a body, cell, header, note or text box. */
function readBlocks(ctx: Ctx, story: Story, container: Element, tableLayers: readonly TableLayer[], onSection?: (sectPr: Element, after: number) => void): Block[] {
  const out: Block[] = []
  const visit = (el: Element) => {
    for (const c of children(el)) {
      if (c.namespaceURI === NS.mc && c.localName === 'AlternateContent') {
        const alt = alternate(c)
        if (alt) visit(alt)
        continue
      }
      if (c.namespaceURI === NS.m && c.localName === 'oMathPara') {
        out.push({ type: 'placeholder', label: 'Equation shown as plain text', text: descendants(c, NS.m, 't').map((t) => t.textContent ?? '').join(''), source: c })
        continue
      }
      if (c.namespaceURI !== NS.w) continue
      const n = c.localName
      if (n === 'p') {
        const p = readParagraph(ctx, story, c, tableLayers)
        out.push(p)
        const sectPr = wc(wc(c, 'pPr'), 'sectPr')
        if (sectPr && onSection) onSection(sectPr, out.length)
      } else if (n === 'tbl') out.push(readTable(ctx, story, c, tableLayers))
      else if (n === 'sdt') visit(wc(c, 'sdtContent') ?? c)
      else if (n === 'customXml' || n === 'ins' || n === 'moveTo') visit(c)
      else if (n === 'del' || n === 'moveFrom') {
        ctx.flags.changes = true
        visit(c)
      } else if (n === 'bookmarkStart') {
        const name = wa(c, 'name')
        if (name) story.pendingBookmarks.push({ type: 'bookmark', name, source: c })
      } else if (n === 'altChunk') out.push({ type: 'placeholder', label: 'Imported content (altChunk) not shown yet', text: '', source: c })
      else if (!IGNORED.has(n)) out.push({ type: 'placeholder', label: `Unsupported content (${label(c)}) not shown`, text: '', source: c })
    }
  }
  visit(container)
  return out
}

// ---------------------------------------------------------------- package level

function relMap(pkg: OpcPackage, part: string): Map<string, Relationship> {
  return new Map(pkg.relationships(part).map((r) => [r.id, r]))
}

function partOfType(pkg: OpcPackage, source: string, type: string): string | null {
  const rel = pkg.relationships(source).find((r) => r.type === type && !r.external)
  return rel?.part && pkg.has(rel.part) ? rel.part : null
}

function themeFonts(doc: XMLDocument | null): ThemeFonts {
  if (!doc?.documentElement) return EMPTY_THEME_FONTS
  const scheme = descendants(doc.documentElement, NS.a, 'fontScheme')[0]
  if (!scheme) return EMPTY_THEME_FONTS
  const read = (el: Element | null) => {
    const face = (local: string) => attr(child(el, NS.a, local), null, 'typeface') || undefined
    const out: ThemeFonts['major'] = {}
    const latin = face('latin')
    const ea = face('ea')
    const cs = face('cs')
    if (latin) out.latin = latin
    if (ea) out.ea = ea
    if (cs) out.cs = cs
    return out
  }
  return { major: read(child(scheme, NS.a, 'majorFont')), minor: read(child(scheme, NS.a, 'minorFont')) }
}

function fontTable(doc: XMLDocument | null): Map<string, FontInfo> {
  const out = new Map<string, FontInfo>()
  if (!doc?.documentElement) return out
  for (const f of wcs(doc.documentElement, 'font')) {
    const name = wa(f, 'name')
    if (!name) continue
    out.set(name, { name, altName: wa(wc(f, 'altName'), 'val'), family: wa(wc(f, 'family'), 'val'), pitch: wa(wc(f, 'pitch'), 'val') })
  }
  return out
}

function settingsOf(doc: XMLDocument | null): DocxSettings {
  const root = doc?.documentElement ?? null
  const tab = twipsPt(wa(wc(root, 'defaultTabStop'), 'val'))
  const evenOdd = wc(root, 'evenAndOddHeaders')
  return {
    defaultTabStopPt: tab && tab > 0 ? tab : 36,
    evenAndOddHeaders: onOff(evenOdd) ?? false,
  }
}

/** Reads a .docx into the document model. Throws DocxError (or OpcError) with a readable reason. */
export function parseDocx(bytes: Uint8Array): DocxDocument {
  let pkg: OpcPackage
  try {
    pkg = readPackage(bytes)
  } catch (err) {
    throw new DocxError(err instanceof OpcError ? err.message : `Not a Word document: ${String(err)}`)
  }
  let mainPart: string
  try {
    mainPart = pkg.mainPart(REL_OFFICE_DOCUMENT)
  } catch (err) {
    throw new DocxError(err instanceof Error ? err.message : String(err))
  }
  if (!pkg.has(mainPart)) throw new DocxError(`The package names ${mainPart} as its document, but that part is missing.`)
  const main = safeXml(pkg, mainPart)
  const root = main.documentElement!
  if (root.namespaceURI === NS.wStrict) throw new DocxError('Strict Open XML Word documents are not supported yet.')
  if (!isEl(root, NS.w, 'document')) throw new DocxError(`${mainPart} is not a WordprocessingML document (its root is ${label(root)}).`)
  const body = wc(root, 'body')
  if (!body) throw new DocxError('The document has no body.')

  const optional = (type: string) => {
    const part = partOfType(pkg, mainPart, type)
    return part ? safeXml(pkg, part) : null
  }
  const theme = themeFonts(optional(REL.theme))
  const styles = parseStyles(optional(REL.styles), theme)
  const numbering = parseNumbering(optional(REL.numbering), theme, (styleId) => {
    const s = styles.styles.get(styleId)
    return s?.pPr.numbering?.numId ?? null
  })
  const notesPart = (type: string) => {
    const m = new Map<string, Element>()
    const doc = optional(type)
    if (doc?.documentElement) {
      for (const n of children(doc.documentElement)) {
        const t = wa(n, 'type')
        if (t === 'separator' || t === 'continuationSeparator' || t === 'continuationNotice') continue
        const id = wa(n, 'id')
        if (id !== null) m.set(id, n)
      }
    }
    return m
  }
  const ctx: Ctx = {
    pkg,
    styles,
    numbering,
    theme,
    notes: { footnote: notesPart(REL.footnotes), endnote: notesPart(REL.endnotes) },
    noteOrder: { footnote: [], endnote: [] },
    noteMarks: new Map(),
    flags: { changes: false },
  }
  const mainRels = relMap(pkg, mainPart)
  const story = (part: string, rels: Map<string, Relationship>, counter: ListCounter): Story => ({ part, rels, counter, fields: [], pendingBookmarks: [] })
  const bodyStory = story(mainPart, mainRels, new ListCounter(numbering))

  const resolveRel = (id: string) => {
    const rel = mainRels.get(id)
    return rel && !rel.external && rel.part && pkg.has(rel.part) ? rel.part : null
  }
  const sectionEnds: { sectPr: Element; after: number }[] = []
  const blocks = readBlocks(ctx, bodyStory, body, [], (sectPr, after) => sectionEnds.push({ sectPr, after }))
  const finalSectPr = wc(body, 'sectPr')

  const sections: Section[] = []
  let start = 0
  for (const end of sectionEnds) {
    sections.push({ props: parseSectionProps(end.sectPr, resolveRel), blocks: blocks.slice(start, end.after), source: end.sectPr })
    start = end.after
  }
  sections.push({ props: parseSectionProps(finalSectPr, resolveRel), blocks: blocks.slice(start), source: finalSectPr })
  // A section without a header/footer of some type uses the previous section's (§17.10.5).
  for (let i = 1; i < sections.length; i++) {
    const prev = sections[i - 1]!.props
    const cur = sections[i]!.props
    const inherit = (a: HeaderFooterRefs, b: HeaderFooterRefs): HeaderFooterRefs => ({ ...a, ...b })
    cur.headers = inherit(prev.headers, cur.headers)
    cur.footers = inherit(prev.footers, cur.footers)
  }

  const headerFooters = new Map<string, Block[]>()
  for (const s of sections) {
    for (const part of [...Object.values(s.props.headers), ...Object.values(s.props.footers)]) {
      if (!part || headerFooters.has(part)) continue
      const doc = safeXml(pkg, part)
      const hf = story(part, relMap(pkg, part), new ListCounter(numbering))
      headerFooters.set(part, readBlocks(ctx, hf, doc.documentElement!, []))
    }
  }

  const readNotes = (kind: 'footnote' | 'endnote', type: string): Note[] => {
    const part = partOfType(pkg, mainPart, type)
    if (!part) return []
    const noteStory = story(part, relMap(pkg, part), new ListCounter(numbering))
    return ctx.noteOrder[kind].flatMap((id) => {
      const el = ctx.notes[kind].get(id)
      if (!el) return []
      const mark = ctx.noteMarks.get(`${kind}:${id}`) ?? ''
      const blocks = readBlocks(ctx, noteStory, el, [])
      setNoteMarks(blocks, mark)
      return [{ id, kind, mark, blocks, source: el }]
    })
  }
  const footnotes = readNotes('footnote', REL.footnotes)
  const endnotes = readNotes('endnote', REL.endnotes)

  const notices: string[] = []
  if (partOfType(pkg, mainPart, REL.comments)) notices.push('Comments are not shown yet.')
  if (ctx.flags.changes) notices.push('Tracked changes are shown marked up: insertions underlined, deletions struck through.')

  return {
    pkg,
    mainPart,
    styles,
    numbering,
    themeFonts: theme,
    fonts: fontTable(optional(REL.fontTable)),
    settings: settingsOf(optional(REL.settings)),
    sections,
    headerFooters,
    footnotes,
    endnotes,
    notices,
  }
}

function setNoteMarks(blocks: Block[], mark: string) {
  const walk = (inlines: Inline[]) => {
    for (const i of inlines) {
      if (i.type === 'noteMark') i.mark = mark
      else if (i.type === 'link' || i.type === 'field' || i.type === 'change') walk(i.children)
    }
  }
  for (const b of blocks) if (b.type === 'paragraph') walk(b.inlines)
}

function safeXml(pkg: OpcPackage, part: string): XMLDocument {
  try {
    return pkg.xml(part)
  } catch (err) {
    // The XML parser throws its own error for fatal markup errors (unclosed tags), not only OpcError.
    throw new DocxError(`Could not read ${part}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------- helpers for consumers

/** The text of inlines as Word shows it (deleted text and hidden runs left out, field results in). */
export function inlineText(inlines: readonly Inline[]): string {
  let out = ''
  for (const i of inlines) {
    switch (i.type) {
      case 'text':
        if (!i.run.vanish) out += i.text
        break
      case 'tab':
        out += '\t'
        break
      case 'break':
        out += '\n'
        break
      case 'symbol':
        out += String.fromCodePoint(i.code)
        break
      case 'link':
      case 'field':
        out += inlineText(i.children)
        break
      case 'change':
        if (i.kind === 'insert') out += inlineText(i.children)
        break
      case 'ruby':
        out += inlineText(i.base)
        break
      case 'noteRef':
      case 'noteMark':
        out += i.mark
        break
      case 'placeholder':
        out += i.text
        break
    }
  }
  return out
}

export const paragraphText = (p: Paragraph) => inlineText(p.inlines)
