import type {
  Background,
  Deck,
  Fill,
  GroupXfrm,
  Hyperlink,
  Layout,
  Line,
  LineEnd,
  ListStyle,
  Master,
  MatrixRef,
  ParaProps,
  PicNode,
  Placeholder,
  RunProps,
  ShapeNode,
  ShapeStyle,
  Slide,
  Spacing,
  Table,
  TableStylePart,
  TextBody,
  Theme,
  Xfrm,
} from './model'
import { resolveColor, type ColorContext, type ColorSpec, type Rgba } from './color'
import { buildGeometry, GeometryError, type BuiltGeometry, type GeomDef } from './geometry'
import { walkShapes } from './model'
import { presetGeometry } from './presets'

/**
 * Inheritance, worked out (ECMA-376 Part 1 §19.3.1, §21.1.2): a slide's
 * placeholders take position, geometry, fill, line, body and text styles
 * from the matching layout placeholder and then the master's, matched by
 * placeholder idx and type — never by name. Text runs inherit through the
 * presentation default, the master's title/body/other style, each level's
 * list style and the paragraph. Colours resolve through the theme and the
 * effective colour map. The result is a render-ready slide in CSS pixels
 * (96 per inch), which ./render.ts turns into SVG.
 */

export const EMU_PER_PX = 9525
const px = (emu: number) => emu / EMU_PER_PX
/** Hundredths of a point → px. */
const ptPx = (hundredths: number) => (hundredths / 100) * (96 / 72)

export type Frame = { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean }

export type RFill =
  | { kind: 'none' }
  | { kind: 'solid'; color: Rgba }
  | {
      kind: 'gradient'
      stops: Array<{ pos: number; color: Rgba }>
      linear: { angle: number; scaled: boolean } | null
      path: 'circle' | 'rect' | 'shape' | null
      focus: { l: number; t: number; r: number; b: number }
    }
  | {
      kind: 'image'
      image: PicNode['blip']['image']
      /** Crop as fractions of the image (negative: padding). */
      crop: { l: number; t: number; r: number; b: number }
      /** Where the image sits in the frame (stretch fillRect), as fractions inset. */
      inset: { l: number; t: number; r: number; b: number }
      tile: { tx: number; ty: number; sx: number; sy: number; flip: string; algn: string } | null
      alpha: number
    }
  | { kind: 'pattern'; preset: string; fg: Rgba; bg: Rgba }

export type RLine = {
  width: number
  fill: RFill
  dash: string
  custDash: Array<{ d: number; sp: number }> | null
  cap: 'butt' | 'round' | 'square'
  join: 'round' | 'bevel' | 'miter'
  head: LineEnd | null
  tail: LineEnd | null
}

export type RLink = { kind: 'url'; href: string } | { kind: 'slide'; index: number } | { kind: 'unsupported'; what: string }

export type RRun = {
  text: string
  isBreak: boolean
  size: number
  bold: boolean
  italic: boolean
  underline: string | null
  strike: string | null
  fill: RFill
  fonts: string[]
  baseline: number
  caps: 'none' | 'small' | 'all'
  spacing: number
  highlight: Rgba | null
  link: RLink | null
}

export type RSpacing = { pct: number } | { px: number }

export type RBullet = { text: string; color: RFill; size: number; fonts: string[] }

export type RParagraph = {
  level: number
  align: string
  marL: number
  marR: number
  indent: number
  rtl: boolean
  lineSpacing: RSpacing
  spaceBefore: RSpacing
  spaceAfter: RSpacing
  bullet: RBullet | null
  runs: RRun[]
  /** Font size of the paragraph mark (an empty paragraph's line height). */
  endSize: number
}

export type RText = {
  /** The text box inside the frame (geometry text rectangle minus insets), px. */
  box: { x: number; y: number; w: number; h: number }
  anchor: 't' | 'ctr' | 'b' | 'just' | 'dist'
  anchorCtr: boolean
  wrap: boolean
  vert: string
  rot: number
  columns: number
  paragraphs: RParagraph[]
}

export type RCell = {
  row: number
  col: number
  colSpan: number
  rowSpan: number
  /** Covered by a merge: not drawn. */
  covered: boolean
  fill: RFill
  borders: { l: RLine | null; r: RLine | null; t: RLine | null; b: RLine | null }
  insets: { l: number; t: number; r: number; b: number }
  anchor: 't' | 'ctr' | 'b'
  vert: string
  paragraphs: RParagraph[]
}
export type RTable = { cols: number[]; rows: Array<{ h: number; cells: RCell[] }>; missingStyle: string | null }

export type RNode =
  | {
      kind: 'shape'
      id: string
      name: string
      frame: Frame
      geometry: BuiltGeometry
      /** A preset or custom geometry this reader does not draw: shown as a labelled outline. */
      unknownGeometry: string | null
      fill: RFill
      line: RLine | null
      text: RText | null
      placeholder: string | null
    }
  | { kind: 'picture'; id: string; name: string; descr: string; frame: Frame; geometry: BuiltGeometry; image: Extract<RFill, { kind: 'image' }>; line: RLine | null; media: 'video' | 'audio' | null }
  | { kind: 'table'; id: string; name: string; frame: Frame; table: RTable }
  | { kind: 'placeholder'; id: string; name: string; frame: Frame; label: string }
  | { kind: 'group'; id: string; name: string; children: RNode[] }

export type RSlide = {
  index: number
  width: number
  height: number
  background: RFill
  nodes: RNode[]
  /** Things on the slide that could not be placed (no position anywhere in their inheritance): named, not dropped. */
  notShown: string[]
}

// ---------------------------------------------------------------------------
// Context

type Ctx = {
  deck: Deck
  slide: Slide | null
  master: Master
  layout: Layout | null
  theme: Theme
  color: ColorContext
  slideIndex: Map<string, number>
}

function contextFor(deck: Deck, slide: Slide): Ctx {
  const layout = deck.layouts[slide.layout]!
  const master = deck.masters[layout.master]!
  const theme = deck.themes[master.theme]!
  const clrMap = slide.clrMapOvr ?? layout.clrMapOvr ?? master.clrMap
  return {
    deck,
    slide,
    master,
    layout,
    theme,
    color: { theme: theme.colors, clrMap },
    slideIndex: new Map(deck.slides.map((s, i) => [s.part, i])),
  }
}

const rgba = (spec: ColorSpec | null | undefined, ctx: Ctx, phClr?: ColorSpec | null): Rgba | null => resolveColor(spec, phClr ? { ...ctx.color, phClr } : ctx.color)

// ---------------------------------------------------------------------------
// Placeholders

/** Title-ish and body-ish placeholder families (§19.7.10 ST_PlaceholderType). */
function family(type: string): string {
  if (type === 'title' || type === 'ctrTitle') return 'title'
  if (['body', 'subTitle', 'obj', 'chart', 'tbl', 'clipArt', 'dgm', 'media', 'pic'].includes(type)) return 'body'
  return type
}

/**
 * The placeholder in `shapes` that `ph` inherits from: the same idx (when the
 * file gives one), else the same type, else the same family of type.
 */
export function findPlaceholder(shapes: ShapeNode[], ph: Placeholder, useIdx: boolean): ShapeNode | null {
  const phs = [...walkShapes(shapes)].filter((s) => s.ph)
  if (useIdx && ph.idx !== null) {
    const byIdx = phs.find((s) => (s.ph!.idx ?? 0) === ph.idx)
    if (byIdx) return byIdx
  }
  return phs.find((s) => s.ph!.type === ph.type) ?? phs.find((s) => family(s.ph!.type) === family(ph.type)) ?? null
}

/** A shape and what it inherits from, highest first: [own, layout placeholder, master placeholder]. */
function inheritance(ctx: Ctx, shape: ShapeNode, onSlide: boolean): ShapeNode[] {
  if (!shape.ph) return [shape]
  const chain: ShapeNode[] = [shape]
  let layoutPh: ShapeNode | null = null
  if (onSlide && ctx.layout) layoutPh = findPlaceholder(ctx.layout.shapes, shape.ph, true)
  if (layoutPh) chain.push(layoutPh)
  const masterPh = findPlaceholder(ctx.master.shapes, (layoutPh ?? shape).ph!, false)
  if (masterPh && masterPh !== shape) chain.push(masterPh)
  return chain
}

const spPrOf = (s: ShapeNode) => (s.kind === 'sp' || s.kind === 'pic' ? s.spPr : null)
const styleOf = (s: ShapeNode): ShapeStyle | null => (s.kind === 'sp' || s.kind === 'pic' ? s.style : null)
const textOf = (s: ShapeNode): TextBody | null => (s.kind === 'sp' ? s.text : null)

// ---------------------------------------------------------------------------
// Fills and lines

const frac = (v: number) => v / 100000

export function resolveFill(fill: Fill | null, ctx: Ctx, phClr: ColorSpec | null, groupFill: RFill | null): RFill {
  if (!fill) return { kind: 'none' }
  switch (fill.kind) {
    case 'none':
      return fill
    case 'solid': {
      const c = rgba(fill.color, ctx, phClr)
      return c ? { kind: 'solid', color: c } : { kind: 'none' }
    }
    case 'gradient': {
      const stops = fill.stops.flatMap((s) => {
        const c = rgba(s.color, ctx, phClr)
        return c ? [{ pos: frac(s.pos), color: c }] : []
      })
      if (stops.length === 0) return { kind: 'none' }
      return {
        kind: 'gradient',
        stops,
        linear: fill.linear,
        path: fill.path,
        focus: { l: frac(fill.fillToRect.l), t: frac(fill.fillToRect.t), r: frac(fill.fillToRect.r), b: frac(fill.fillToRect.b) },
      }
    }
    case 'blip': {
      const crop = fill.srcRect ?? { l: 0, t: 0, r: 0, b: 0 }
      const inset = fill.stretch ?? { l: 0, t: 0, r: 0, b: 0 }
      return {
        kind: 'image',
        image: fill.image,
        crop: { l: frac(crop.l), t: frac(crop.t), r: frac(crop.r), b: frac(crop.b) },
        inset: { l: frac(inset.l), t: frac(inset.t), r: frac(inset.r), b: frac(inset.b) },
        tile: fill.tile,
        alpha: fill.alpha === null ? 1 : frac(fill.alpha),
      }
    }
    case 'pattern':
      return {
        kind: 'pattern',
        preset: fill.preset,
        fg: rgba(fill.fg, ctx, phClr) ?? { r: 0, g: 0, b: 0, a: 1 },
        bg: rgba(fill.bg, ctx, phClr) ?? { r: 255, g: 255, b: 255, a: 1 },
      }
    case 'group':
      return groupFill ?? { kind: 'none' }
  }
}

/** A style-matrix fill reference: 0 none, 1–999 the theme's fill styles, 1001+ its background fills. */
function refFill(ref: MatrixRef, ctx: Ctx): RFill {
  if (ref.idx === 0) return { kind: 'none' }
  const f = ref.idx >= 1001 ? ctx.theme.bgFills[ref.idx - 1001] : ctx.theme.fills[ref.idx - 1]
  return resolveFill(f ?? null, ctx, ref.color, null)
}

function shapeFill(ctx: Ctx, chain: ShapeNode[], groupFill: RFill | null): RFill {
  for (const s of chain) {
    const spPr = spPrOf(s)
    if (spPr?.fill) return resolveFill(spPr.fill, ctx, styleOf(s)?.fill?.color ?? null, groupFill)
    const ref = styleOf(s)?.fill
    if (ref) return refFill(ref, ctx)
  }
  return { kind: 'none' }
}

const EMPTY_LINE: Line = { width: null, fill: null, dash: null, custDash: null, cap: null, join: null, head: null, tail: null }

function mergeLine(base: Line, over: Line | null): Line {
  if (!over) return base
  const out: Line = { ...base }
  for (const k of Object.keys(over) as Array<keyof Line>) if (over[k] !== null) (out as Record<string, unknown>)[k] = over[k]
  return out
}

function finishLine(line: Line, phClr: ColorSpec | null, ctx: Ctx, groupFill: RFill | null): RLine | null {
  if (!line.fill) return null
  const fill = resolveFill(line.fill, ctx, phClr, groupFill)
  if (fill.kind === 'none') return null
  const cap = line.cap === 'rnd' ? 'round' : line.cap === 'sq' ? 'square' : 'butt'
  const join = line.join === 'round' ? 'round' : line.join === 'bevel' ? 'bevel' : 'miter'
  // No width: 0.75 pt. Width 0 is the thinnest line the device draws (a hairline), not an invisible one.
  const width = line.width === null ? px(9525) : line.width === 0 ? 1 : px(line.width)
  return { width, fill, dash: line.dash ?? 'solid', custDash: line.custDash, cap, join, head: line.head, tail: line.tail }
}

export function resolveLine(ctx: Ctx, chain: ShapeNode[], groupFill: RFill | null): RLine | null {
  let line: Line = EMPTY_LINE
  let phClr: ColorSpec | null = null
  for (const s of [...chain].reverse()) {
    const ref = styleOf(s)?.line
    if (ref) {
      phClr = ref.color
      line = ref.idx === 0 ? { ...EMPTY_LINE, fill: { kind: 'none' } } : mergeLine(line, ctx.theme.lines[ref.idx - 1] ?? null)
    }
    line = mergeLine(line, spPrOf(s)?.line ?? null)
  }
  return finishLine(line, phClr, ctx, groupFill)
}

// ---------------------------------------------------------------------------
// Frames

function frameOf(x: Xfrm, groups: GroupXfrm[]): Frame {
  let f = { x: x.x, y: x.y, w: x.cx, h: x.cy, rot: x.rot, flipH: x.flipH, flipV: x.flipV }
  // Map from the innermost group's child space outward (§20.1.7.6 group transforms).
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!
    const sx = g.chCx ? g.cx / g.chCx : 1
    const sy = g.chCy ? g.cy / g.chCy : 1
    let nx = g.x + (f.x - g.chX) * sx
    let ny = g.y + (f.y - g.chY) * sy
    const nw = f.w * sx
    const nh = f.h * sy
    let { rot, flipH, flipV } = f
    if (g.flipH) {
      nx = g.x + g.cx - (nx - g.x) - nw
      flipH = !flipH
      rot = -rot
    }
    if (g.flipV) {
      ny = g.y + g.cy - (ny - g.y) - nh
      flipV = !flipV
      rot = -rot
    }
    if (g.rot) {
      const gcx = g.x + g.cx / 2
      const gcy = g.y + g.cy / 2
      const ccx = nx + nw / 2 - gcx
      const ccy = ny + nh / 2 - gcy
      const r = (g.rot * Math.PI) / 180
      nx = gcx + ccx * Math.cos(r) - ccy * Math.sin(r) - nw / 2
      ny = gcy + ccx * Math.sin(r) + ccy * Math.cos(r) - nh / 2
      rot += g.rot
    }
    f = { x: nx, y: ny, w: nw, h: nh, rot, flipH, flipV }
  }
  return { x: px(f.x), y: px(f.y), w: px(f.w), h: px(f.h), rot: ((f.rot % 360) + 360) % 360, flipH: f.flipH, flipV: f.flipV }
}

function xfrmOf(chain: ShapeNode[]): Xfrm | null {
  for (const s of chain) {
    const x = s.kind === 'sp' || s.kind === 'pic' ? s.spPr.xfrm : s.kind === 'frame' || s.kind === 'other' ? s.xfrm : s.kind === 'group' ? s.xfrm : null
    if (x) return x
  }
  return null
}

// ---------------------------------------------------------------------------
// Geometry

const RECT_DEF = presetGeometry('rect')!

function geometryOf(chain: ShapeNode[], frame: Frame, fallbackName: string | null): { geometry: BuiltGeometry; unknown: string | null } {
  const w = frame.w * EMU_PER_PX
  const h = frame.h * EMU_PER_PX
  const scale = 1 / EMU_PER_PX
  for (const s of chain) {
    const g = spPrOf(s)?.geom
    if (!g) continue
    let def: GeomDef | null
    let av: Record<string, string> = {}
    let label: string
    if (g.kind === 'preset') {
      def = presetGeometry(g.name)
      av = g.av
      label = `${g.name} shape`
    } else {
      def = g.def
      label = 'custom shape'
    }
    if (!def) return { geometry: buildGeometry(RECT_DEF, w, h, {}, scale), unknown: label }
    try {
      return { geometry: buildGeometry(def, w, h, av, scale), unknown: null }
    } catch (err) {
      if (err instanceof GeometryError) return { geometry: buildGeometry(RECT_DEF, w, h, {}, scale), unknown: `${label} (${err.message})` }
      throw err
    }
  }
  return { geometry: buildGeometry(RECT_DEF, w, h, {}, scale), unknown: fallbackName }
}

// ---------------------------------------------------------------------------
// Text

function mergeRun(base: RunProps, over: RunProps | undefined): RunProps {
  return over ? { ...base, ...over } : base
}

function mergePara(base: ParaProps, over: ParaProps | null | undefined): ParaProps {
  if (!over) return base
  return { ...base, ...over, defRPr: mergeRun(base.defRPr ?? {}, over.defRPr) }
}

const levelOf = (ls: ListStyle, lvl: number): ParaProps => mergePara(ls.def ?? {}, ls.levels[lvl])

type TextLayers = {
  /** List styles from lowest to highest priority (presentation default … the shape's own lstStyle). */
  lists: ListStyle[]
  autofit: { fontScale: number; lnSpcReduction: number }
}

function fontName(name: string | undefined, theme: Theme): string | null {
  if (!name) return null
  const m = /^\+(mj|mn)-(lt|ea|cs)$/.exec(name)
  if (m) {
    const set = m[1] === 'mj' ? theme.fonts.major : theme.fonts.minor
    const v = m[2] === 'lt' ? set.latin : m[2] === 'ea' ? set.ea : set.cs
    return v || null
  }
  return name
}

function fontsOf(r: RunProps, theme: Theme): string[] {
  const out: string[] = []
  for (const f of [r.latin, r.ea, r.cs]) {
    const n = fontName(f, theme)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

function linkOf(link: Hyperlink | undefined, ctx: Ctx): RLink | null {
  if (!link) return null
  switch (link.kind) {
    case 'external':
      return /^(https?:|mailto:)/i.test(link.url) ? { kind: 'url', href: link.url } : { kind: 'unsupported', what: link.url }
    case 'slide': {
      const index = ctx.slideIndex.get(link.part)
      return index === undefined ? { kind: 'unsupported', what: 'a slide that is not in this deck' } : { kind: 'slide', index }
    }
    case 'jump': {
      if (!ctx.slide) return null
      const cur = ctx.slide.number - 1
      const last = ctx.deck.slides.length - 1
      const index = link.to === 'next' ? Math.min(last, cur + 1) : link.to === 'previous' ? Math.max(0, cur - 1) : link.to === 'first' ? 0 : last
      return { kind: 'slide', index }
    }
    case 'action':
      return { kind: 'unsupported', what: link.action }
  }
}

const HLINK: ColorSpec = { kind: 'scheme', name: 'hlink', mods: [] }

function resolveRun(text: string, isBreak: boolean, props: RunProps, ctx: Ctx, layers: TextLayers): RRun {
  const link = linkOf(props.link, ctx)
  let fill: RFill = props.fill ? resolveFill(props.fill, ctx, null, null) : { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } }
  // Hyperlinks take the theme's hyperlink colour (§20.1.4.1.13) and are underlined.
  if (link) fill = { kind: 'solid', color: rgba(HLINK, ctx) ?? { r: 5, g: 99, b: 193, a: 1 } }
  const cap = props.cap === 'small' ? 'small' : props.cap === 'all' ? 'all' : 'none'
  return {
    text,
    isBreak,
    size: ptPx(props.size ?? 1800) * layers.autofit.fontScale,
    bold: props.bold ?? false,
    italic: props.italic ?? false,
    underline: link && (!props.underline || props.underline === 'none') ? 'sng' : props.underline && props.underline !== 'none' ? props.underline : null,
    strike: props.strike && props.strike !== 'noStrike' ? props.strike : null,
    fill,
    fonts: fontsOf(props, ctx.theme),
    baseline: (props.baseline ?? 0) / 1000,
    caps: cap,
    spacing: props.spacing ? ptPx(props.spacing) : 0,
    highlight: props.highlight ? rgba(props.highlight, ctx) : null,
    link,
  }
}

const ROMAN: Array<[number, string]> = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
]
const roman = (n: number) => {
  let out = ''
  for (const [v, s] of ROMAN) {
    while (n >= v) {
      out += s
      n -= v
    }
  }
  return out
}
const alpha = (n: number) => {
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(97 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** ST_TextAutonumberScheme (§20.1.10.61) for the Latin schemes; others number with Arabic digits. */
export function autonumber(scheme: string, n: number): string {
  const m = /^(arabic|alphaLc|alphaUc|romanLc|romanUc)(Period|ParenR|ParenBoth|Plain|Minus|DbPeriod|DbPlain)?/.exec(scheme)
  if (scheme === 'circleNumDbPlain' || scheme === 'circleNumWdBlackPlain' || scheme === 'circleNumWdWhitePlain') {
    return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n)
  }
  const kind = m?.[1] ?? 'arabic'
  const suffix = m?.[2] ?? 'Period'
  const num = kind === 'alphaLc' ? alpha(n) : kind === 'alphaUc' ? alpha(n).toUpperCase() : kind === 'romanLc' ? roman(n) : kind === 'romanUc' ? roman(n).toUpperCase() : String(n)
  if (suffix === 'ParenR') return `${num})`
  if (suffix === 'ParenBoth') return `(${num})`
  if (suffix === 'Plain' || suffix === 'DbPlain') return num
  if (suffix === 'Minus') return `- ${num} -`
  return `${num}.`
}

function spacingOf(s: Spacing | undefined, dflt: RSpacing, reduction: number): RSpacing {
  if (!s) return dflt
  if ('pct' in s) return { pct: Math.max(0, frac(s.pct) - reduction) }
  return { px: ptPx(s.pts) }
}

export function resolveParagraphs(body: TextBody, ctx: Ctx, layers: TextLayers): RParagraph[] {
  const counters: Array<{ scheme: string; n: number } | null> = []
  const out: RParagraph[] = []
  const reduction = layers.autofit.lnSpcReduction
  for (const p of body.paragraphs) {
    const level = p.props.lvl ?? 0
    let pp: ParaProps = {}
    for (const ls of layers.lists) pp = mergePara(pp, levelOf(ls, level))
    pp = mergePara(pp, levelOf(body.lstStyle, level))
    pp = mergePara(pp, p.props)
    const runDefaults = pp.defRPr ?? {}
    const runs = p.runs.map((r) => {
      const props = mergeRun(runDefaults, r.props)
      if (r.kind === 'break') return resolveRun('', true, props, ctx, layers)
      const text = r.kind === 'field' && r.type === 'slidenum' && ctx.slide ? String(ctx.slide.number) : r.text
      return resolveRun(text, false, props, ctx, layers)
    })
    const end = resolveRun('', false, mergeRun(runDefaults, p.endProps), ctx, layers)
    const hasText = runs.some((r) => r.text.length > 0)

    for (let l = level + 1; l < counters.length; l++) counters[l] = null
    let bullet: RBullet | null = null
    const b = pp.bullet
    if (hasText && b && (b.kind === 'char' || b.kind === 'autonum')) {
      let text: string
      if (b.kind === 'char') {
        text = b.char
        counters[level] = null
      } else {
        const prev = counters[level]
        const n = prev && prev.scheme === b.scheme ? prev.n + 1 : b.startAt
        counters[level] = { scheme: b.scheme, n }
        text = autonumber(b.scheme, n)
      }
      const first = runs.find((r) => r.text.length > 0) ?? end
      const size = pp.buSize === undefined || pp.buSize === 'text' ? first.size : 'pct' in pp.buSize ? first.size * frac(pp.buSize.pct) : ptPx(pp.buSize.pts) * layers.autofit.fontScale
      const color: RFill = pp.buColor === undefined || pp.buColor === 'text' ? first.fill : { kind: 'solid', color: rgba(pp.buColor, ctx) ?? { r: 0, g: 0, b: 0, a: 1 } }
      const fonts = pp.buFont === undefined || pp.buFont === 'text' ? first.fonts : [fontName(pp.buFont, ctx.theme) ?? pp.buFont]
      bullet = { text, color, size, fonts }
    } else if (hasText) counters[level] = null

    out.push({
      level,
      align: pp.align ?? 'l',
      marL: px(pp.marL ?? 0),
      marR: px(pp.marR ?? 0),
      indent: px(pp.indent ?? 0),
      rtl: pp.rtl ?? false,
      lineSpacing: spacingOf(pp.lnSpc, { pct: Math.max(0, 1 - reduction) }, reduction),
      spaceBefore: spacingOf(pp.spcBef, { px: 0 }, 0),
      spaceAfter: spacingOf(pp.spcAft, { px: 0 }, 0),
      bullet,
      runs,
      endSize: end.size,
    })
  }
  return out
}

/** The master text style a placeholder type takes (§19.3.1.51 txStyles). */
function masterStyleFor(master: Master, ph: Placeholder | null): ListStyle {
  if (!ph) return master.txStyles.other
  const f = family(ph.type)
  return f === 'title' ? master.txStyles.title : f === 'body' ? master.txStyles.body : master.txStyles.other
}

function fontRefLayer(style: ShapeStyle | null): ListStyle | null {
  const ref = style?.font
  if (!ref || (!ref.color && ref.idx === 'none')) return null
  const defRPr: RunProps = {}
  if (ref.color) defRPr.fill = { kind: 'solid', color: ref.color }
  if (ref.idx === 'major' || ref.idx === 'minor') {
    const p = ref.idx === 'major' ? '+mj' : '+mn'
    defRPr.latin = `${p}-lt`
    defRPr.ea = `${p}-ea`
    defRPr.cs = `${p}-cs`
  }
  return { def: { defRPr }, levels: [] }
}

function textOfShape(ctx: Ctx, chain: ShapeNode[], geometry: BuiltGeometry): RText | null {
  const own = textOf(chain[0]!)
  if (!own || own.paragraphs.every((p) => p.runs.every((r) => r.kind !== 'break' && r.text === ''))) return null
  const bodyPr = [...chain].reverse().reduce((acc, s) => ({ ...acc, ...(textOf(s)?.bodyPr ?? {}) }), {} as TextBody['bodyPr'])
  const lists: ListStyle[] = [ctx.deck.defaultTextStyle, masterStyleFor(ctx.master, chain[0]!.ph)]
  const fontRef = fontRefLayer(styleOf(chain[0]!))
  if (fontRef) lists.push(fontRef)
  for (const s of [...chain].reverse().slice(0, -1)) {
    const t = textOf(s)
    if (t) lists.push(t.lstStyle)
  }
  const autofit = bodyPr.autofit?.kind === 'norm' ? { fontScale: frac(bodyPr.autofit.fontScale), lnSpcReduction: frac(bodyPr.autofit.lnSpcReduction) } : { fontScale: 1, lnSpcReduction: 0 }
  const rect = geometry.textRect
  const l = px(bodyPr.lIns ?? 91440)
  const t = px(bodyPr.tIns ?? 45720)
  const r = px(bodyPr.rIns ?? 91440)
  const b = px(bodyPr.bIns ?? 45720)
  const anchor = (['t', 'ctr', 'b', 'just', 'dist'] as const).find((x) => x === bodyPr.anchor) ?? 't'
  return {
    box: { x: rect.l + l, y: rect.t + t, w: Math.max(0, rect.r - rect.l - l - r), h: Math.max(0, rect.b - rect.t - t - b) },
    anchor,
    anchorCtr: bodyPr.anchorCtr ?? false,
    wrap: bodyPr.wrap !== 'none',
    vert: bodyPr.vert ?? 'horz',
    rot: bodyPr.rot ?? 0,
    columns: Math.max(1, bodyPr.numCol ?? 1),
    paragraphs: resolveParagraphs(own, ctx, { lists, autofit }),
  }
}

// ---------------------------------------------------------------------------
// Tables

type CellAcc = { fill: RFill | null; borders: RCell['borders']; text: TableStylePart['text'] }

function refLine(ref: MatrixRef, ctx: Ctx): RLine | null {
  if (ref.idx === 0) return null
  return finishLine(ctx.theme.lines[ref.idx - 1] ?? EMPTY_LINE, ref.color, ctx, null)
}

function resolveTable(table: Table, ctx: Ctx): RTable {
  const style = table.styleId ? (ctx.deck.tableStyles[table.styleId] ?? null) : null
  const nRows = table.rows.length
  const nCols = table.grid.length
  const f = table.flags
  const rows = table.rows.map((row, r) => {
    let c = 0
    const cells: RCell[] = row.cells.map((cell) => {
      const col = c
      c += 1
      const acc: CellAcc = { fill: null, borders: { l: null, r: null, t: null, b: null }, text: {} }
      const apply = (name: string, region: { r0: number; r1: number; c0: number; c1: number }) => {
        const part = style?.parts[name]
        if (!part) return
        if (part.fill) acc.fill = resolveFill(part.fill, ctx, null, null)
        else if (part.fillRef) acc.fill = refFill(part.fillRef, ctx)
        const lastCol = col + cell.gridSpan - 1
        const lastRow = r + cell.rowSpan - 1
        const edges: Array<[keyof RCell['borders'], 'left' | 'right' | 'top' | 'bottom' | 'insideH' | 'insideV']> = [
          ['l', col === region.c0 ? 'left' : 'insideV'],
          ['r', lastCol === region.c1 ? 'right' : 'insideV'],
          ['t', r === region.r0 ? 'top' : 'insideH'],
          ['b', lastRow === region.r1 ? 'bottom' : 'insideH'],
        ]
        for (const [edge, name2] of edges) {
          const bdr = part.borders[name2]
          if (!bdr) continue
          acc.borders[edge] = bdr.line ? finishLine(bdr.line, null, ctx, null) : bdr.ref ? refLine(bdr.ref, ctx) : null
        }
        acc.text = { ...acc.text, ...part.text }
      }
      const all = { r0: 0, r1: nRows - 1, c0: 0, c1: nCols - 1 }
      apply('wholeTbl', all)
      const bodyRow = r - (f.firstRow ? 1 : 0)
      const inBodyRows = !(f.firstRow && r === 0) && !(f.lastRow && r === nRows - 1)
      if (f.bandRow && inBodyRows) apply(bodyRow % 2 === 0 ? 'band1H' : 'band2H', { r0: r, r1: r, c0: 0, c1: nCols - 1 })
      const bodyCol = col - (f.firstCol ? 1 : 0)
      const inBodyCols = !(f.firstCol && col === 0) && !(f.lastCol && col === nCols - 1)
      if (f.bandCol && inBodyCols) apply(bodyCol % 2 === 0 ? 'band1V' : 'band2V', { r0: 0, r1: nRows - 1, c0: col, c1: col })
      if (f.lastCol && col + cell.gridSpan - 1 === nCols - 1) apply('lastCol', { r0: 0, r1: nRows - 1, c0: nCols - 1, c1: nCols - 1 })
      if (f.firstCol && col === 0) apply('firstCol', { r0: 0, r1: nRows - 1, c0: 0, c1: 0 })
      if (f.lastRow && r === nRows - 1) apply('lastRow', { r0: nRows - 1, r1: nRows - 1, c0: 0, c1: nCols - 1 })
      if (f.firstRow && r === 0) apply('firstRow', { r0: 0, r1: 0, c0: 0, c1: nCols - 1 })

      const p = cell.props
      const fill = p.fill ? resolveFill(p.fill, ctx, null, null) : (acc.fill ?? (table.fill ? resolveFill(table.fill, ctx, null, null) : { kind: 'none' as const }))
      const borders = { ...acc.borders }
      for (const k of ['l', 'r', 't', 'b'] as const) {
        const own = p.borders[k]
        if (own) borders[k] = finishLine(mergeLine(EMPTY_LINE, own), null, ctx, null)
      }
      const textLayer: ListStyle = { def: { defRPr: {} }, levels: [] }
      const d = textLayer.def!.defRPr!
      if (acc.text.bold !== undefined) d.bold = acc.text.bold
      if (acc.text.italic !== undefined) d.italic = acc.text.italic
      if (acc.text.color) d.fill = { kind: 'solid', color: acc.text.color }
      if (acc.text.font === 'major' || acc.text.font === 'minor') d.latin = acc.text.font === 'major' ? '+mj-lt' : '+mn-lt'
      const insets = { l: px(p.marL ?? 91440), r: px(p.marR ?? 91440), t: px(p.marT ?? 45720), b: px(p.marB ?? 45720) }
      const anchor = (['t', 'ctr', 'b'] as const).find((x) => x === p.anchor) ?? 't'
      const paragraphs = cell.text
        ? resolveParagraphs(cell.text, ctx, { lists: [ctx.deck.defaultTextStyle, ctx.master.txStyles.other, textLayer], autofit: { fontScale: 1, lnSpcReduction: 0 } })
        : []
      return { row: r, col, colSpan: cell.gridSpan, rowSpan: cell.rowSpan, covered: cell.hMerge || cell.vMerge, fill, borders, insets, anchor, vert: p.vert ?? 'horz', paragraphs }
    })
    return { h: px(row.h), cells }
  })
  return { cols: table.grid.map(px), rows, missingStyle: table.styleId && !style ? table.styleId : null }
}

// ---------------------------------------------------------------------------
// Shapes

function resolveShape(ctx: Ctx, shape: ShapeNode, groups: GroupXfrm[], groupFill: RFill | null, onSlide: boolean, notShown: string[]): RNode | null {
  if (shape.hidden) return null
  const chain = inheritance(ctx, shape, onSlide)
  if (shape.kind === 'group') {
    const fill = shape.fill ? resolveFill(shape.fill, ctx, null, groupFill) : groupFill
    const inner = shape.xfrm ? [...groups, shape.xfrm] : groups
    return { kind: 'group', id: shape.id, name: shape.name, children: shape.children.flatMap((c) => resolveShape(ctx, c, inner, fill, onSlide, notShown) ?? []) }
  }
  const xfrm = xfrmOf(chain)
  if (!xfrm) {
    // Nothing in its inheritance says where it goes: named in the slide's list, not dropped silently.
    const what = shape.kind === 'other' ? shape.what : shape.name || shape.kind
    if (shape.kind !== 'sp' || textOf(shape)?.paragraphs.some((p) => p.runs.some((r) => r.kind !== 'break' && r.text !== ''))) notShown.push(what)
    return null
  }
  const frame = frameOf(xfrm, groups)
  switch (shape.kind) {
    case 'sp': {
      const { geometry, unknown } = geometryOf(chain, frame, null)
      return {
        kind: 'shape',
        id: shape.id,
        name: shape.name,
        frame,
        geometry,
        unknownGeometry: unknown,
        fill: shapeFill(ctx, chain, groupFill),
        line: resolveLine(ctx, chain, groupFill),
        text: textOfShape(ctx, chain, geometry),
        placeholder: shape.ph?.type ?? null,
      }
    }
    case 'pic':
      return resolvePicture(ctx, shape, chain, frame, groupFill)
    case 'frame': {
      const c = shape.content
      if (c.kind === 'table') return { kind: 'table', id: shape.id, name: shape.name, frame, table: resolveTable(c.table, ctx) }
      if (c.kind === 'ole' && c.preview) {
        const pic = resolvePicture(ctx, c.preview, [c.preview], frame, groupFill)
        return pic
      }
      const label =
        c.kind === 'chart' ? 'Chart' : c.kind === 'diagram' ? 'SmartArt graphic' : c.kind === 'ole' ? `Embedded object${c.progId ? ` (${c.progId})` : ''}` : 'Embedded content'
      return { kind: 'placeholder', id: shape.id, name: shape.name, frame, label: `${label} — not shown yet` }
    }
    case 'other':
      return { kind: 'placeholder', id: shape.id, name: shape.name, frame, label: `${shape.what} — not shown yet` }
  }
}

function resolvePicture(ctx: Ctx, shape: PicNode, chain: ShapeNode[], frame: Frame, groupFill: RFill | null): RNode {
  const { geometry } = geometryOf(chain, frame, null)
  const image = resolveFill(shape.blip, ctx, null, null) as Extract<RFill, { kind: 'image' }>
  return { kind: 'picture', id: shape.id, name: shape.name, descr: shape.descr, frame, geometry, image, line: resolveLine(ctx, chain, groupFill), media: shape.media }
}

function backgroundOf(ctx: Ctx, bg: Background | null): RFill | null {
  if (!bg) return null
  if (bg.kind === 'fill') return resolveFill(bg.fill, ctx, null, null)
  return refFill(bg.ref, ctx)
}

/** A slide, ready to draw: background, then master and layout graphics (unless hidden), then its own shapes. */
export function resolveSlide(deck: Deck, index: number): RSlide {
  const slide = deck.slides[index]
  if (!slide) throw new RangeError(`The deck has no slide ${index + 1}.`)
  const ctx = contextFor(deck, slide)
  const layout = ctx.layout!
  const background = backgroundOf(ctx, slide.bg) ?? backgroundOf(ctx, layout.bg) ?? backgroundOf(ctx, ctx.master.bg) ?? { kind: 'solid' as const, color: { r: 255, g: 255, b: 255, a: 1 } }
  const nodes: RNode[] = []
  const notShown: string[] = []
  const graphics = (shapes: ShapeNode[]) => {
    for (const s of shapes) {
      const n = s.ph ? null : resolveShape(ctx, s, [], null, false, notShown)
      if (n) nodes.push(n)
    }
  }
  if (slide.showMasterSp) {
    if (layout.showMasterSp) graphics(ctx.master.shapes)
    graphics(layout.shapes)
  }
  for (const s of slide.shapes) {
    const n = resolveShape(ctx, s, [], null, true, notShown)
    if (n) nodes.push(n)
  }
  return { index, width: px(deck.size.cx), height: px(deck.size.cy), background, nodes, notShown }
}

/** The text a shape inherits for its placeholder kind, exported for tests and extraction. */
export function placeholderFamily(ph: Placeholder | null): string | null {
  return ph ? family(ph.type) : null
}
