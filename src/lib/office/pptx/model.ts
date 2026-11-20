import { OpcError, readPackage, REL_OFFICE_DOCUMENT, type OpcPackage, type Relationship } from '../ooxml/package'
import { colorIn, type ColorSpec } from './color'
import { readAvLst, readCustGeom, type GeomDef } from './geometry'
import { a, attr, boolAttr, children, intAttr, kids, NS, NS_STRICT_P, p, path, pctAttr, REL_TYPE, relAttr } from './xml'

/**
 * The deck model: what a .pptx says, parsed from the package and kept
 * independent of drawing (./resolve.ts works out inheritance, ./render.ts
 * draws). Plain, serializable data — part names instead of object links —
 * so later editing can be expressed as operations on it. Each node keeps a
 * link to the XML element it came from (`sourceOf`), and the package itself
 * (ooxml/package.ts) writes untouched parts back byte for byte.
 *
 * Units: EMU for lengths, degrees for angles, 1/100000 for percentages,
 * 1/100 pt for font sizes — as in the file.
 */

// ---------------------------------------------------------------------------
// Source links

export type SourceRef = { part: string; el: Element }
const SOURCES = new WeakMap<object, SourceRef>()

/** The XML element (and its part) a model node was read from. */
export function sourceOf(node: object): SourceRef | null {
  return SOURCES.get(node) ?? null
}

function link<T extends object>(node: T, part: string, el: Element): T {
  SOURCES.set(node, { part, el })
  return node
}

// ---------------------------------------------------------------------------
// Types

export type Xfrm = { x: number; y: number; cx: number; cy: number; rot: number; flipH: boolean; flipV: boolean }
export type GroupXfrm = Xfrm & { chX: number; chY: number; chCx: number; chCy: number }

/** ST_PlaceholderType; a placeholder without a type is an object placeholder ("obj"). */
export type Placeholder = { type: string; idx: number | null }

/** Fractions in 1/100000 of the width/height (a:srcRect, a:fillRect, a:fillToRect). */
export type Rect100k = { l: number; t: number; r: number; b: number }

export type ImageRef =
  | { kind: 'part'; part: string; contentType: string }
  | { kind: 'external'; url: string }
  | { kind: 'missing'; rId: string }

export type GradientStop = { pos: number; color: ColorSpec }

export type Fill =
  | { kind: 'none' }
  | { kind: 'solid'; color: ColorSpec }
  | {
      kind: 'gradient'
      stops: GradientStop[]
      linear: { angle: number; scaled: boolean } | null
      path: 'circle' | 'rect' | 'shape' | null
      fillToRect: Rect100k
      rotWithShape: boolean
    }
  | {
      kind: 'blip'
      image: ImageRef | null
      srcRect: Rect100k | null
      stretch: Rect100k | null
      tile: { tx: number; ty: number; sx: number; sy: number; flip: string; algn: string } | null
      alpha: number | null
    }
  | { kind: 'pattern'; preset: string; fg: ColorSpec | null; bg: ColorSpec | null }
  | { kind: 'group' }

export type LineEnd = { type: string; w: string; len: string }

/** Line properties; null fields are unspecified (inherited). */
export type Line = {
  width: number | null
  fill: Fill | null
  dash: string | null
  custDash: Array<{ d: number; sp: number }> | null
  cap: string | null
  join: string | null
  head: LineEnd | null
  tail: LineEnd | null
}

/** A reference into the theme's style matrix (§20.1.4.2.x), with the colour for phClr. */
export type MatrixRef = { idx: number; color: ColorSpec | null }
export type ShapeStyle = {
  line: MatrixRef | null
  fill: MatrixRef | null
  effect: MatrixRef | null
  font: { idx: string; color: ColorSpec | null } | null
}

export type Geometry = { kind: 'preset'; name: string; av: Record<string, string> } | { kind: 'custom'; def: GeomDef }

export type Hyperlink =
  | { kind: 'external'; url: string }
  | { kind: 'slide'; part: string }
  | { kind: 'jump'; to: 'next' | 'previous' | 'first' | 'last' }
  | { kind: 'action'; action: string }

export type RunProps = {
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: string
  strike?: string
  fill?: Fill
  latin?: string
  ea?: string
  cs?: string
  sym?: string
  baseline?: number
  cap?: string
  spacing?: number
  highlight?: ColorSpec
  link?: Hyperlink
}

export type Spacing = { pct: number } | { pts: number }

export type Bullet =
  | { kind: 'none' }
  | { kind: 'char'; char: string }
  | { kind: 'autonum'; scheme: string; startAt: number }
  | { kind: 'blip' }

export type ParaProps = {
  lvl?: number
  align?: string
  marL?: number
  marR?: number
  indent?: number
  rtl?: boolean
  lnSpc?: Spacing
  spcBef?: Spacing
  spcAft?: Spacing
  bullet?: Bullet
  buColor?: ColorSpec | 'text'
  buSize?: { pct: number } | { pts: number } | 'text'
  buFont?: string | 'text'
  defRPr?: RunProps
}

/** a:lstStyle and the master's text styles: a default and levels 1–9 (index 0–8). */
export type ListStyle = { def: ParaProps | null; levels: Array<ParaProps | null> }

export type Autofit = { kind: 'none' } | { kind: 'norm'; fontScale: number; lnSpcReduction: number } | { kind: 'shape' }

export type BodyProps = {
  lIns?: number
  tIns?: number
  rIns?: number
  bIns?: number
  anchor?: string
  anchorCtr?: boolean
  wrap?: string
  vert?: string
  rot?: number
  upright?: boolean
  numCol?: number
  autofit?: Autofit
}

export type TextRun =
  | { kind: 'run'; text: string; props: RunProps }
  | { kind: 'break'; props: RunProps }
  | { kind: 'field'; type: string; text: string; props: RunProps }

export type Paragraph = { props: ParaProps; runs: TextRun[]; endProps: RunProps }
export type TextBody = { bodyPr: BodyProps; lstStyle: ListStyle; paragraphs: Paragraph[] }

export type ShapeProps = { xfrm: Xfrm | null; geom: Geometry | null; fill: Fill | null; line: Line | null }

type Base = { id: string; name: string; descr: string; hidden: boolean; ph: Placeholder | null }

export type SpNode = Base & { kind: 'sp'; spPr: ShapeProps; style: ShapeStyle | null; text: TextBody | null; connector: boolean }
export type PicNode = Base & {
  kind: 'pic'
  spPr: ShapeProps
  style: ShapeStyle | null
  blip: Extract<Fill, { kind: 'blip' }>
  media: 'video' | 'audio' | null
}
export type GroupNode = Base & { kind: 'group'; xfrm: GroupXfrm | null; fill: Fill | null; children: ShapeNode[] }
export type FrameNode = Base & { kind: 'frame'; xfrm: Xfrm | null; content: FrameContent }
/** Something on the slide this reader does not draw yet (ink, an unknown element); never dropped silently. */
export type OtherNode = Base & { kind: 'other'; what: string; xfrm: Xfrm | null }
export type ShapeNode = SpNode | PicNode | GroupNode | FrameNode | OtherNode

export type FrameContent =
  | { kind: 'table'; table: Table }
  | { kind: 'chart' }
  | { kind: 'diagram' }
  | { kind: 'ole'; progId: string | null; preview: PicNode | null }
  | { kind: 'unknown'; uri: string }

export type CellProps = {
  marL?: number
  marR?: number
  marT?: number
  marB?: number
  anchor?: string
  vert?: string
  fill?: Fill
  borders: { l?: Line; r?: Line; t?: Line; b?: Line }
}
export type TableCell = { gridSpan: number; rowSpan: number; hMerge: boolean; vMerge: boolean; text: TextBody | null; props: CellProps }
export type TableRow = { h: number; cells: TableCell[] }
export type TableFlags = { firstRow: boolean; lastRow: boolean; firstCol: boolean; lastCol: boolean; bandRow: boolean; bandCol: boolean }
export type Table = { grid: number[]; rows: TableRow[]; styleId: string | null; flags: TableFlags; fill: Fill | null }

export type TableBorderName = 'left' | 'right' | 'top' | 'bottom' | 'insideH' | 'insideV'
export type TableStylePart = {
  fill: Fill | null
  fillRef: MatrixRef | null
  borders: Partial<Record<TableBorderName, { line: Line | null; ref: MatrixRef | null }>>
  text: { bold?: boolean; italic?: boolean; color?: ColorSpec; font?: string }
}
export type TableStyle = { id: string; name: string; parts: Record<string, TableStylePart> }

export type Background = { kind: 'fill'; fill: Fill } | { kind: 'ref'; ref: MatrixRef }

export type FontTriple = { latin: string; ea: string; cs: string }
export type Theme = {
  part: string
  colors: Record<string, ColorSpec>
  fonts: { major: FontTriple; minor: FontTriple }
  fills: Fill[]
  lines: Line[]
  bgFills: Fill[]
}

export type Master = {
  part: string
  theme: string
  clrMap: Record<string, string>
  bg: Background | null
  shapes: ShapeNode[]
  txStyles: { title: ListStyle; body: ListStyle; other: ListStyle }
  /** The master's layouts in its own order (p:sldLayoutIdLst), used by slides or not. */
  layouts: string[]
}
export type Layout = { part: string; master: string; name: string; clrMapOvr: Record<string, string> | null; bg: Background | null; shapes: ShapeNode[]; showMasterSp: boolean }
export type Slide = {
  part: string
  /** 1-based position in the deck. */
  number: number
  layout: string
  clrMapOvr: Record<string, string> | null
  bg: Background | null
  shapes: ShapeNode[]
  showMasterSp: boolean
  hidden: boolean
  /** The speaker notes (the notes slide's body placeholder), or null. */
  notes: TextBody | null
}

export type Deck = {
  size: { cx: number; cy: number }
  slides: Slide[]
  layouts: Record<string, Layout>
  masters: Record<string, Master>
  themes: Record<string, Theme>
  defaultTextStyle: ListStyle
  tableStyles: Record<string, TableStyle>
}

/** The file is not a PowerPoint deck this reader can open: the message says why. */
export class PptxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PptxError'
  }
}

// ---------------------------------------------------------------------------
// Parsing

/** Per-part context: the package and the part's relationships by id. */
type Ctx = { pkg: OpcPackage; part: string; rels: Map<string, Relationship> }

function ctxFor(pkg: OpcPackage, part: string): Ctx {
  return { pkg, part, rels: new Map(pkg.relationships(part).map((r) => [r.id, r])) }
}

function rootOf(pkg: OpcPackage, part: string, name: string): Element {
  const root = pkg.xml(part).documentElement as unknown as Element | null
  if (!root) throw new PptxError(`${part} is empty.`)
  if (root.namespaceURI === NS_STRICT_P) throw new PptxError('This deck is saved as Strict Open XML, which is not supported yet. Save it as a regular PowerPoint presentation (.pptx).')
  if (root.namespaceURI !== NS.p || root.localName !== name) throw new PptxError(`${part} is not a PresentationML ${name}.`)
  return root
}

const emu = (el: Element | null, name: string) => intAttr(el, name) ?? 0

export function parseXfrm(el: Element | null): Xfrm | null {
  if (!el) return null
  const off = a(el, 'off')
  const ext = a(el, 'ext')
  return {
    x: emu(off, 'x'),
    y: emu(off, 'y'),
    cx: emu(ext, 'cx'),
    cy: emu(ext, 'cy'),
    rot: (intAttr(el, 'rot') ?? 0) / 60000,
    flipH: boolAttr(el, 'flipH') ?? false,
    flipV: boolAttr(el, 'flipV') ?? false,
  }
}

function parseGroupXfrm(el: Element | null): GroupXfrm | null {
  const x = parseXfrm(el)
  if (!x || !el) return null
  const chOff = a(el, 'chOff')
  const chExt = a(el, 'chExt')
  return { ...x, chX: emu(chOff, 'x'), chY: emu(chOff, 'y'), chCx: chExt ? emu(chExt, 'cx') : x.cx, chCy: chExt ? emu(chExt, 'cy') : x.cy }
}

const rect100k = (el: Element | null): Rect100k => ({
  l: pctAttr(el, 'l') ?? 0,
  t: pctAttr(el, 't') ?? 0,
  r: pctAttr(el, 'r') ?? 0,
  b: pctAttr(el, 'b') ?? 0,
})

function imageRef(ctx: Ctx, blip: Element | null): ImageRef | null {
  if (!blip) return null
  const embed = relAttr(blip, 'embed')
  const linked = relAttr(blip, 'link')
  const id = embed ?? linked
  if (!id) return null
  const rel = ctx.rels.get(id)
  if (!rel) return { kind: 'missing', rId: id }
  if (rel.external || !rel.part) return { kind: 'external', url: rel.target }
  if (!ctx.pkg.has(rel.part)) return { kind: 'missing', rId: id }
  return { kind: 'part', part: rel.part, contentType: ctx.pkg.contentType(rel.part) }
}

export function parseBlipFill(ctx: Ctx, el: Element): Extract<Fill, { kind: 'blip' }> {
  const blip = a(el, 'blip')
  const src = a(el, 'srcRect')
  const stretch = a(el, 'stretch')
  const tile = a(el, 'tile')
  const alphaFix = a(blip, 'alphaModFix')
  return {
    kind: 'blip',
    image: imageRef(ctx, blip),
    srcRect: src ? rect100k(src) : null,
    stretch: stretch ? rect100k(a(stretch, 'fillRect')) : null,
    tile: tile
      ? {
          tx: intAttr(tile, 'tx') ?? 0,
          ty: intAttr(tile, 'ty') ?? 0,
          sx: pctAttr(tile, 'sx') ?? 100000,
          sy: pctAttr(tile, 'sy') ?? 100000,
          flip: attr(tile, 'flip') ?? 'none',
          algn: attr(tile, 'algn') ?? 'tl',
        }
      : null,
    alpha: alphaFix ? (pctAttr(alphaFix, 'amt') ?? 100000) : null,
  }
}

/** One fill element (noFill, solidFill, gradFill, blipFill, pattFill, grpFill), or null for anything else. */
function fillFrom(ctx: Ctx, el: Element): Fill | null {
  if (el.namespaceURI !== NS.a && !(el.namespaceURI === NS.p && el.localName === 'blipFill')) return null
  switch (el.localName) {
    case 'noFill':
      return { kind: 'none' }
    case 'solidFill': {
      const color = colorIn(el)
      return color ? { kind: 'solid', color } : { kind: 'none' }
    }
    case 'gradFill': {
      const stops: GradientStop[] = []
      for (const gs of children(a(el, 'gsLst'), NS.a, 'gs')) {
        const color = colorIn(gs)
        if (color) stops.push({ pos: pctAttr(gs, 'pos') ?? 0, color })
      }
      stops.sort((x, y) => x.pos - y.pos)
      const lin = a(el, 'lin')
      const pathEl = a(el, 'path')
      const kind = attr(pathEl, 'path')
      return {
        kind: 'gradient',
        stops,
        linear: lin ? { angle: (intAttr(lin, 'ang') ?? 0) / 60000, scaled: boolAttr(lin, 'scaled') ?? false } : pathEl ? null : { angle: 0, scaled: false },
        path: kind === 'circle' || kind === 'rect' || kind === 'shape' ? kind : null,
        fillToRect: rect100k(a(pathEl, 'fillToRect')),
        rotWithShape: boolAttr(el, 'rotWithShape') ?? true,
      }
    }
    case 'blipFill':
      return parseBlipFill(ctx, el)
    case 'pattFill':
      return { kind: 'pattern', preset: attr(el, 'prst') ?? 'pct5', fg: colorIn(a(el, 'fgClr')), bg: colorIn(a(el, 'bgClr')) }
    case 'grpFill':
      return { kind: 'group' }
    default:
      return null
  }
}

/** The fill among `parent`'s children (spPr, bgPr, tcPr, a:fill …), or null when none is given. */
export function parseFill(ctx: Ctx, parent: Element | null): Fill | null {
  if (!parent) return null
  for (const k of kids(parent)) {
    const f = fillFrom(ctx, k)
    if (f) return f
  }
  return null
}

const lineEnd = (el: Element | null): LineEnd | null => {
  if (!el) return null
  const type = attr(el, 'type') ?? 'none'
  return type === 'none' ? { type, w: 'med', len: 'med' } : { type, w: attr(el, 'w') ?? 'med', len: attr(el, 'len') ?? 'med' }
}

export function parseLine(ctx: Ctx, el: Element | null): Line | null {
  if (!el) return null
  const dash = a(el, 'prstDash')
  const cust = a(el, 'custDash')
  const join = kids(el).find((k) => k.namespaceURI === NS.a && (k.localName === 'round' || k.localName === 'bevel' || k.localName === 'miter'))
  return {
    width: intAttr(el, 'w'),
    fill: parseFill(ctx, el),
    dash: attr(dash, 'val'),
    custDash: cust ? children(cust, NS.a, 'ds').map((ds) => ({ d: pctAttr(ds, 'd') ?? 0, sp: pctAttr(ds, 'sp') ?? 0 })) : null,
    cap: attr(el, 'cap'),
    join: join?.localName ?? null,
    head: lineEnd(a(el, 'headEnd')),
    tail: lineEnd(a(el, 'tailEnd')),
  }
}

const matrixRef = (el: Element | null): MatrixRef | null => (el ? { idx: intAttr(el, 'idx') ?? 0, color: colorIn(el) } : null)

function parseStyle(el: Element | null): ShapeStyle | null {
  if (!el) return null
  const font = a(el, 'fontRef')
  return {
    line: matrixRef(a(el, 'lnRef')),
    fill: matrixRef(a(el, 'fillRef')),
    effect: matrixRef(a(el, 'effectRef')),
    font: font ? { idx: attr(font, 'idx') ?? 'none', color: colorIn(font) } : null,
  }
}

function parseGeometry(spPr: Element | null): Geometry | null {
  const prst = a(spPr, 'prstGeom')
  if (prst) return { kind: 'preset', name: attr(prst, 'prst') ?? 'rect', av: readAvLst(a(prst, 'avLst')) }
  const cust = a(spPr, 'custGeom')
  if (cust) return { kind: 'custom', def: readCustGeom(cust) }
  return null
}

function parseSpPr(ctx: Ctx, spPr: Element | null): ShapeProps {
  return { xfrm: parseXfrm(a(spPr, 'xfrm')), geom: parseGeometry(spPr), fill: parseFill(ctx, spPr), line: parseLine(ctx, a(spPr, 'ln')) }
}

function hyperlink(ctx: Ctx, el: Element | null): Hyperlink | undefined {
  if (!el) return undefined
  const action = attr(el, 'action') ?? ''
  const id = relAttr(el, 'id')
  const rel = id ? ctx.rels.get(id) : undefined
  if (action.startsWith('ppaction://hlinkshowjump')) {
    const to = /jump=(\w+)/.exec(action)?.[1]
    const map: Record<string, 'next' | 'previous' | 'first' | 'last'> = { nextslide: 'next', previousslide: 'previous', firstslide: 'first', lastslide: 'last' }
    if (to && map[to]) return { kind: 'jump', to: map[to] }
    return { kind: 'action', action }
  }
  if (action.startsWith('ppaction://hlinksldjump') && rel?.part) return { kind: 'slide', part: rel.part }
  if (rel?.external) return { kind: 'external', url: rel.target }
  if (action) return { kind: 'action', action }
  return undefined
}

function parseRPr(ctx: Ctx, el: Element | null): RunProps {
  const out: RunProps = {}
  if (!el) return out
  const sz = intAttr(el, 'sz')
  if (sz !== null) out.size = sz
  const b = boolAttr(el, 'b')
  if (b !== null) out.bold = b
  const i = boolAttr(el, 'i')
  if (i !== null) out.italic = i
  const u = attr(el, 'u')
  if (u !== null) out.underline = u
  const strike = attr(el, 'strike')
  if (strike !== null) out.strike = strike
  const baseline = pctAttr(el, 'baseline')
  if (baseline !== null) out.baseline = baseline
  const cap = attr(el, 'cap')
  if (cap !== null) out.cap = cap
  const spc = intAttr(el, 'spc')
  if (spc !== null) out.spacing = spc
  const fill = parseFill(ctx, el)
  if (fill) out.fill = fill
  for (const name of ['latin', 'ea', 'cs', 'sym'] as const) {
    const f = attr(a(el, name), 'typeface')
    if (f !== null) out[name] = f
  }
  const hl = colorIn(a(el, 'highlight'))
  if (hl) out.highlight = hl
  const link = hyperlink(ctx, a(el, 'hlinkClick'))
  if (link) out.link = link
  return out
}

function spacing(el: Element | null): Spacing | undefined {
  if (!el) return undefined
  const pct = a(el, 'spcPct')
  if (pct) return { pct: pctAttr(pct, 'val') ?? 100000 }
  const pts = a(el, 'spcPts')
  if (pts) return { pts: intAttr(pts, 'val') ?? 0 }
  return undefined
}

export function parsePPr(ctx: Ctx, el: Element | null): ParaProps {
  const out: ParaProps = {}
  if (!el) return out
  const lvl = intAttr(el, 'lvl')
  if (lvl !== null) out.lvl = Math.max(0, Math.min(8, lvl))
  const algn = attr(el, 'algn')
  if (algn !== null) out.align = algn
  for (const k of ['marL', 'marR', 'indent'] as const) {
    const v = intAttr(el, k)
    if (v !== null) out[k] = v
  }
  const rtl = boolAttr(el, 'rtl')
  if (rtl !== null) out.rtl = rtl
  const lnSpc = spacing(a(el, 'lnSpc'))
  if (lnSpc) out.lnSpc = lnSpc
  const spcBef = spacing(a(el, 'spcBef'))
  if (spcBef) out.spcBef = spcBef
  const spcAft = spacing(a(el, 'spcAft'))
  if (spcAft) out.spcAft = spcAft
  for (const k of kids(el)) {
    if (k.namespaceURI !== NS.a) continue
    switch (k.localName) {
      case 'buClrTx':
        out.buColor = 'text'
        break
      case 'buClr': {
        const c = colorIn(k)
        if (c) out.buColor = c
        break
      }
      case 'buSzTx':
        out.buSize = 'text'
        break
      case 'buSzPct':
        out.buSize = { pct: pctAttr(k, 'val') ?? 100000 }
        break
      case 'buSzPts':
        out.buSize = { pts: intAttr(k, 'val') ?? 1800 }
        break
      case 'buFontTx':
        out.buFont = 'text'
        break
      case 'buFont':
        out.buFont = attr(k, 'typeface') ?? 'text'
        break
      case 'buNone':
        out.bullet = { kind: 'none' }
        break
      case 'buAutoNum':
        out.bullet = { kind: 'autonum', scheme: attr(k, 'type') ?? 'arabicPeriod', startAt: intAttr(k, 'startAt') ?? 1 }
        break
      case 'buChar':
        out.bullet = { kind: 'char', char: attr(k, 'char') ?? '•' }
        break
      case 'buBlip':
        out.bullet = { kind: 'blip' }
        break
      case 'defRPr':
        out.defRPr = parseRPr(ctx, k)
        break
    }
  }
  return out
}

export function parseListStyle(ctx: Ctx, el: Element | null): ListStyle {
  const levels: Array<ParaProps | null> = []
  for (let i = 1; i <= 9; i++) {
    const lvl = a(el, `lvl${i}pPr`)
    levels.push(lvl ? parsePPr(ctx, lvl) : null)
  }
  const def = a(el, 'defPPr')
  return { def: def ? parsePPr(ctx, def) : null, levels }
}

function parseBodyPr(el: Element | null): BodyProps {
  const out: BodyProps = {}
  if (!el) return out
  for (const k of ['lIns', 'tIns', 'rIns', 'bIns', 'numCol'] as const) {
    const v = intAttr(el, k)
    if (v !== null) out[k] = v
  }
  const rot = intAttr(el, 'rot')
  if (rot !== null) out.rot = rot / 60000
  for (const k of ['anchor', 'wrap', 'vert'] as const) {
    const v = attr(el, k)
    if (v !== null) out[k] = v
  }
  const anchorCtr = boolAttr(el, 'anchorCtr')
  if (anchorCtr !== null) out.anchorCtr = anchorCtr
  const upright = boolAttr(el, 'upright')
  if (upright !== null) out.upright = upright
  if (a(el, 'noAutofit')) out.autofit = { kind: 'none' }
  const norm = a(el, 'normAutofit')
  if (norm) out.autofit = { kind: 'norm', fontScale: pctAttr(norm, 'fontScale') ?? 100000, lnSpcReduction: pctAttr(norm, 'lnSpcReduction') ?? 0 }
  if (a(el, 'spAutoFit')) out.autofit = { kind: 'shape' }
  return out
}

export function parseTextBody(ctx: Ctx, el: Element | null): TextBody | null {
  if (!el) return null
  const paragraphs: Paragraph[] = []
  for (const pEl of children(el, NS.a, 'p')) {
    const runs: TextRun[] = []
    for (const k of kids(pEl)) {
      if (k.namespaceURI !== NS.a) continue
      if (k.localName === 'r') runs.push({ kind: 'run', text: a(k, 't')?.textContent ?? '', props: parseRPr(ctx, a(k, 'rPr')) })
      else if (k.localName === 'br') runs.push({ kind: 'break', props: parseRPr(ctx, a(k, 'rPr')) })
      else if (k.localName === 'fld') runs.push({ kind: 'field', type: attr(k, 'type') ?? '', text: a(k, 't')?.textContent ?? '', props: parseRPr(ctx, a(k, 'rPr')) })
    }
    paragraphs.push(link({ props: parsePPr(ctx, a(pEl, 'pPr')), runs, endProps: parseRPr(ctx, a(pEl, 'endParaRPr')) }, ctx.part, pEl))
  }
  return link({ bodyPr: parseBodyPr(a(el, 'bodyPr')), lstStyle: parseListStyle(ctx, a(el, 'lstStyle')), paragraphs }, ctx.part, el)
}

function base(nv: Element | null): Base {
  const c = p(nv, 'cNvPr')
  const phEl = path(nv, 'p:nvPr/p:ph')
  return {
    id: attr(c, 'id') ?? '',
    name: attr(c, 'name') ?? '',
    descr: attr(c, 'descr') ?? '',
    hidden: boolAttr(c, 'hidden') ?? false,
    ph: phEl ? { type: attr(phEl, 'type') ?? 'obj', idx: intAttr(phEl, 'idx') } : null,
  }
}

function parseTable(ctx: Ctx, tbl: Element): Table {
  const pr = a(tbl, 'tblPr')
  const flag = (n: string) => boolAttr(pr, n) ?? false
  const rows: TableRow[] = children(tbl, NS.a, 'tr').map((tr) =>
    link(
      {
        h: intAttr(tr, 'h') ?? 0,
        cells: children(tr, NS.a, 'tc').map((tc) => {
          const tcPr = a(tc, 'tcPr')
          const props: CellProps = { borders: {} }
          for (const k of ['marL', 'marR', 'marT', 'marB'] as const) {
            const v = intAttr(tcPr, k)
            if (v !== null) props[k] = v
          }
          const anchor = attr(tcPr, 'anchor')
          if (anchor) props.anchor = anchor
          const vert = attr(tcPr, 'vert')
          if (vert) props.vert = vert
          const fill = parseFill(ctx, tcPr)
          if (fill) props.fill = fill
          for (const [k, n] of [['l', 'lnL'], ['r', 'lnR'], ['t', 'lnT'], ['b', 'lnB']] as const) {
            const ln = parseLine(ctx, a(tcPr, n))
            if (ln) props.borders[k] = ln
          }
          return link(
            {
              gridSpan: intAttr(tc, 'gridSpan') ?? 1,
              rowSpan: intAttr(tc, 'rowSpan') ?? 1,
              hMerge: boolAttr(tc, 'hMerge') ?? false,
              vMerge: boolAttr(tc, 'vMerge') ?? false,
              text: parseTextBody(ctx, a(tc, 'txBody')),
              props,
            },
            ctx.part,
            tc,
          )
        }),
      },
      ctx.part,
      tr,
    ),
  )
  return {
    grid: children(a(tbl, 'tblGrid'), NS.a, 'gridCol').map((g) => intAttr(g, 'w') ?? 0),
    rows,
    styleId: a(pr, 'tableStyleId')?.textContent?.trim() || null,
    flags: { firstRow: flag('firstRow'), lastRow: flag('lastRow'), firstCol: flag('firstCol'), lastCol: flag('lastCol'), bandRow: flag('bandRow'), bandCol: flag('bandCol') },
    fill: parseFill(ctx, pr),
  }
}

const URI = {
  table: 'http://schemas.openxmlformats.org/drawingml/2006/table',
  chart: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  diagram: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  ole: 'http://schemas.openxmlformats.org/presentationml/2006/ole',
}

function parsePic(ctx: Ctx, el: Element): PicNode {
  const nv = p(el, 'nvPicPr')
  const nvPr = p(nv, 'nvPr')
  const media = a(nvPr, 'videoFile') || a(nvPr, 'quickTimeFile') ? 'video' : a(nvPr, 'audioFile') || a(nvPr, 'wavAudioFile') ? 'audio' : null
  const blipFill = p(el, 'blipFill') ?? a(el, 'blipFill')
  return link(
    {
      ...base(nv),
      kind: 'pic',
      spPr: parseSpPr(ctx, p(el, 'spPr')),
      style: parseStyle(p(el, 'style')),
      blip: blipFill ? parseBlipFill(ctx, blipFill) : { kind: 'blip', image: null, srcRect: null, stretch: null, tile: null, alpha: null },
      media,
    },
    ctx.part,
    el,
  )
}

export function parseShapes(ctx: Ctx, tree: Element | null): ShapeNode[] {
  const out: ShapeNode[] = []
  if (!tree) return out
  for (const el of kids(tree)) {
    if (el.namespaceURI !== NS.p) continue
    switch (el.localName) {
      case 'sp': {
        const nv = p(el, 'nvSpPr')
        out.push(
          link(
            { ...base(nv), kind: 'sp', spPr: parseSpPr(ctx, p(el, 'spPr')), style: parseStyle(p(el, 'style')), text: parseTextBody(ctx, p(el, 'txBody')), connector: false },
            ctx.part,
            el,
          ),
        )
        break
      }
      case 'cxnSp': {
        const nv = p(el, 'nvCxnSpPr')
        out.push(link({ ...base(nv), kind: 'sp', spPr: parseSpPr(ctx, p(el, 'spPr')), style: parseStyle(p(el, 'style')), text: null, connector: true }, ctx.part, el))
        break
      }
      case 'pic':
        out.push(parsePic(ctx, el))
        break
      case 'grpSp': {
        const nv = p(el, 'nvGrpSpPr')
        const pr = p(el, 'grpSpPr')
        out.push(link({ ...base(nv), kind: 'group', xfrm: parseGroupXfrm(a(pr, 'xfrm')), fill: parseFill(ctx, pr), children: parseShapes(ctx, el) }, ctx.part, el))
        break
      }
      case 'graphicFrame': {
        const nv = p(el, 'nvGraphicFramePr')
        const data = path(el, 'a:graphic/a:graphicData')
        const uri = attr(data, 'uri') ?? ''
        let content: FrameContent
        if (uri === URI.table && a(data, 'tbl')) content = { kind: 'table', table: parseTable(ctx, a(data, 'tbl')!) }
        else if (uri === URI.chart) content = { kind: 'chart' }
        else if (uri === URI.diagram) content = { kind: 'diagram' }
        else if (uri === URI.ole) {
          const ole = p(data, 'oleObj')
          const preview = p(ole, 'pic')
          content = { kind: 'ole', progId: attr(ole, 'progId'), preview: preview ? parsePic(ctx, preview) : null }
        } else content = { kind: 'unknown', uri }
        out.push(link({ ...base(nv), kind: 'frame', xfrm: parseXfrm(p(el, 'xfrm')), content }, ctx.part, el))
        break
      }
      case 'contentPart': {
        out.push(link({ id: '', name: 'Ink', descr: '', hidden: false, ph: null, kind: 'other', what: 'Ink drawing', xfrm: parseXfrm(p(el, 'xfrm')) }, ctx.part, el))
        break
      }
      case 'nvGrpSpPr':
      case 'grpSpPr':
      case 'extLst':
        break
      default:
        out.push(link({ id: '', name: el.localName ?? '', descr: '', hidden: false, ph: null, kind: 'other', what: el.localName ?? 'element', xfrm: null }, ctx.part, el))
    }
  }
  return out
}

function parseBackground(ctx: Ctx, cSld: Element | null): Background | null {
  const bg = p(cSld, 'bg')
  if (!bg) return null
  const bgPr = p(bg, 'bgPr')
  if (bgPr) {
    const fill = parseFill(ctx, bgPr)
    return fill ? { kind: 'fill', fill } : null
  }
  const ref = matrixRef(p(bg, 'bgRef'))
  return ref ? { kind: 'ref', ref } : null
}

const CLR_MAP_KEYS = ['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']

function parseClrMap(el: Element | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of CLR_MAP_KEYS) {
    const v = attr(el, k)
    if (v) out[k] = v
  }
  return out
}

function parseClrMapOvr(el: Element | null): Record<string, string> | null {
  const o = a(el, 'overrideClrMapping')
  return o ? parseClrMap(o) : null
}

function parseTheme(pkg: OpcPackage, part: string): Theme {
  const ctx = ctxFor(pkg, part)
  const root = pkg.xml(part).documentElement as unknown as Element
  if (!root || root.namespaceURI !== NS.a || root.localName !== 'theme') throw new PptxError(`${part} is not a DrawingML theme.`)
  const els = a(root, 'themeElements')
  const colors: Record<string, ColorSpec> = {}
  for (const k of kids(a(els, 'clrScheme'))) {
    const c = colorIn(k)
    if (c && k.localName) colors[k.localName] = c
  }
  const font = (el: Element | null): FontTriple => ({
    latin: attr(a(el, 'latin'), 'typeface') ?? '',
    ea: attr(a(el, 'ea'), 'typeface') ?? '',
    cs: attr(a(el, 'cs'), 'typeface') ?? '',
  })
  const fs = a(els, 'fontScheme')
  const fmt = a(els, 'fmtScheme')
  const fills = (list: Element | null) => kids(list).map((k) => fillFrom(ctx, k) ?? { kind: 'none' as const })
  return {
    part,
    colors,
    fonts: { major: font(a(fs, 'majorFont')), minor: font(a(fs, 'minorFont')) },
    fills: fills(a(fmt, 'fillStyleLst')),
    lines: children(a(fmt, 'lnStyleLst'), NS.a, 'ln').map((ln) => parseLine(ctx, ln)!),
    bgFills: fills(a(fmt, 'bgFillStyleLst')),
  }
}

function parseTableStyles(pkg: OpcPackage, part: string): Record<string, TableStyle> {
  const ctx = ctxFor(pkg, part)
  const root = pkg.xml(part).documentElement as unknown as Element
  const out: Record<string, TableStyle> = {}
  for (const st of children(root, NS.a, 'tblStyle')) {
    const id = attr(st, 'styleId') ?? ''
    const parts: Record<string, TableStylePart> = {}
    for (const partEl of kids(st)) {
      if (partEl.namespaceURI !== NS.a || !partEl.localName) continue
      const tx = a(partEl, 'tcTxStyle')
      const tc = a(partEl, 'tcStyle')
      const bdr = a(tc, 'tcBdr')
      const borders: TableStylePart['borders'] = {}
      for (const n of ['left', 'right', 'top', 'bottom', 'insideH', 'insideV'] as const) {
        const e = a(bdr, n)
        if (e) borders[n] = { line: parseLine(ctx, a(e, 'ln')), ref: matrixRef(a(e, 'lnRef')) }
      }
      const text: TableStylePart['text'] = {}
      const b = attr(tx, 'b')
      if (b) text.bold = b === 'on'
      const i = attr(tx, 'i')
      if (i) text.italic = i === 'on'
      const color = colorIn(tx) ?? colorIn(a(tx, 'fontRef'))
      if (color) text.color = color
      const fontRef = attr(a(tx, 'fontRef'), 'idx')
      if (fontRef) text.font = fontRef
      parts[partEl.localName] = { fill: parseFill(ctx, a(tc, 'fill')), fillRef: matrixRef(a(tc, 'fillRef')), borders, text }
    }
    out[id] = { id, name: attr(st, 'styleName') ?? '', parts }
  }
  return out
}

function relOfType(pkg: OpcPackage, part: string, type: string): string | null {
  return pkg.relationships(part).find((r) => r.type === type && !r.external && r.part && pkg.has(r.part))?.part ?? null
}

/** Opens a deck: the package (for media and saving) and its model. Throws PptxError/OpcError with a reason. */
export function openDeck(bytes: Uint8Array): { pkg: OpcPackage; deck: Deck } {
  const pkg = readPackage(bytes)
  return { pkg, deck: readDeck(pkg) }
}

/** The presentation part of a package (the main part). */
export function presentationPart(pkg: OpcPackage): string {
  try {
    return pkg.mainPart(REL_OFFICE_DOCUMENT)
  } catch (err) {
    if (err instanceof OpcError) throw new PptxError('This file has no presentation in it.')
    throw err
  }
}

/** Reads the deck model from a package as it is now (after edits, ./ops.ts). */
export function readDeck(pkg: OpcPackage): Deck {
  const presPart = presentationPart(pkg)
  const pres = rootOf(pkg, presPart, 'presentation')
  const pctx = ctxFor(pkg, presPart)
  const sz = p(pres, 'sldSz')
  const size = { cx: intAttr(sz, 'cx') ?? 9144000, cy: intAttr(sz, 'cy') ?? 6858000 }

  const themes: Record<string, Theme> = {}
  const masters: Record<string, Master> = {}
  const layouts: Record<string, Layout> = {}

  const theme = (part: string) => (themes[part] ??= parseTheme(pkg, part))

  function master(part: string): Master {
    const found = masters[part]
    if (found) return found
    const root = rootOf(pkg, part, 'sldMaster')
    const ctx = ctxFor(pkg, part)
    const themePart = relOfType(pkg, part, REL_TYPE.theme)
    if (!themePart) throw new PptxError(`The slide master ${part} has no theme.`)
    theme(themePart)
    const cSld = p(root, 'cSld')
    const tx = p(root, 'txStyles')
    const m: Master = link(
      {
        part,
        theme: themePart,
        clrMap: parseClrMap(p(root, 'clrMap')),
        bg: parseBackground(ctx, cSld),
        shapes: parseShapes(ctx, p(cSld, 'spTree')),
        txStyles: { title: parseListStyle(ctx, p(tx, 'titleStyle')), body: parseListStyle(ctx, p(tx, 'bodyStyle')), other: parseListStyle(ctx, p(tx, 'otherStyle')) },
        layouts: [],
      },
      part,
      root,
    )
    masters[part] = m
    for (const id of children(p(root, 'sldLayoutIdLst'), NS.p, 'sldLayoutId')) {
      const rel = ctx.rels.get(relAttr(id, 'id') ?? '')
      if (rel?.part && pkg.has(rel.part)) {
        layout(rel.part)
        m.layouts.push(rel.part)
      }
    }
    return m
  }

  function layout(part: string): Layout {
    const found = layouts[part]
    if (found) return found
    const root = rootOf(pkg, part, 'sldLayout')
    const ctx = ctxFor(pkg, part)
    const masterPart = relOfType(pkg, part, REL_TYPE.slideMaster)
    if (!masterPart) throw new PptxError(`The slide layout ${part} has no master.`)
    master(masterPart)
    const cSld = p(root, 'cSld')
    const l: Layout = link(
      {
        part,
        master: masterPart,
        name: attr(cSld, 'name') ?? '',
        clrMapOvr: parseClrMapOvr(p(root, 'clrMapOvr')),
        bg: parseBackground(ctx, cSld),
        shapes: parseShapes(ctx, p(cSld, 'spTree')),
        showMasterSp: boolAttr(root, 'showMasterSp') ?? true,
      },
      part,
      root,
    )
    layouts[part] = l
    return l
  }

  // Masters listed by the presentation load even when no slide uses them.
  for (const id of children(p(pres, 'sldMasterIdLst'), NS.p, 'sldMasterId')) {
    const rel = pctx.rels.get(relAttr(id, 'id') ?? '')
    if (rel?.part && pkg.has(rel.part)) master(rel.part)
  }

  const slides: Slide[] = []
  for (const id of children(p(pres, 'sldIdLst'), NS.p, 'sldId')) {
    const rId = relAttr(id, 'id') ?? ''
    const rel = pctx.rels.get(rId)
    if (!rel?.part || !pkg.has(rel.part)) throw new PptxError(`Slide ${slides.length + 1} is missing from the file (${rId}).`)
    const part = rel.part
    const root = rootOf(pkg, part, 'sld')
    const ctx = ctxFor(pkg, part)
    const layoutPart = relOfType(pkg, part, REL_TYPE.slideLayout)
    if (!layoutPart) throw new PptxError(`Slide ${slides.length + 1} has no layout.`)
    layout(layoutPart)
    const cSld = p(root, 'cSld')
    let notes: TextBody | null = null
    const notesPart = relOfType(pkg, part, REL_TYPE.notesSlide)
    if (notesPart) {
      const nRoot = rootOf(pkg, notesPart, 'notes')
      const nctx = ctxFor(pkg, notesPart)
      const body = parseShapes(nctx, path(nRoot, 'p:cSld/p:spTree')).find((s): s is SpNode => s.kind === 'sp' && s.ph?.type === 'body')
      notes = body?.text ?? null
    }
    slides.push(
      link(
        {
          part,
          number: slides.length + 1,
          layout: layoutPart,
          clrMapOvr: parseClrMapOvr(p(root, 'clrMapOvr')),
          bg: parseBackground(ctx, cSld),
          shapes: parseShapes(ctx, p(cSld, 'spTree')),
          showMasterSp: boolAttr(root, 'showMasterSp') ?? true,
          hidden: boolAttr(root, 'show') === false,
          notes,
        },
        part,
        root,
      ),
    )
  }

  const tsPart = relOfType(pkg, presPart, REL_TYPE.tableStyles)
  const deck: Deck = link(
    {
      size,
      slides,
      layouts,
      masters,
      themes,
      defaultTextStyle: parseListStyle(pctx, p(pres, 'defaultTextStyle')),
      tableStyles: tsPart ? parseTableStyles(pkg, tsPart) : {},
    },
    presPart,
    pres,
  )
  return deck
}

/** Every shape of a tree, depth first, groups included. */
export function* walkShapes(shapes: ShapeNode[]): Generator<ShapeNode> {
  for (const s of shapes) {
    yield s
    if (s.kind === 'group') yield* walkShapes(s.children)
  }
}
