import type { BuiltGeometry, BuiltPath } from './geometry'
import type { ImageRef, LineEnd } from './model'
import type { Frame, RCell, RFill, RLine, RNode, RParagraph, RRun, RSlide, RTable, RText } from './resolve'
import { toCss, type Rgba } from './color'

/**
 * Draws a resolved slide (./resolve.ts) as one SVG document, in CSS pixels
 * (viewBox = slide size), so it scales crisply to any size: the main view,
 * thumbnails and presenter mode use the same markup.
 *
 * Text is laid out by the browser in `<foreignObject>` HTML rather than as
 * measured `<tspan>`s: it gets real line breaking (UAX #14), bidi, CJK
 * vertical writing, font fallback, selection and copy for free, scales with
 * the viewBox like the shapes, and is the same DOM text the S2 editor will
 * make editable (contenteditable, IME, spellcheck). Measured tspans would
 * need our own font metrics and line breaker and could never be edited.
 *
 * Everything from the file is escaped; links are limited to http(s)/mailto
 * (resolve.ts) and the only other URLs are the image URLs the caller gives.
 */

export type MediaSource = (part: string) => { url: string; width: number | null; height: number | null } | null

export type RenderOptions = {
  /** Prefix for ids in the SVG (gradients, clip paths, markers): unique per rendering on a page. */
  idPrefix: string
  /** Image URLs for media parts (blob: URLs in the browser). */
  media: MediaSource
  /** Make hyperlinks clickable (the main view and presenter mode, not thumbnails). */
  links?: boolean
  /** Accessible name of the slide. */
  label?: string
}

const XHTML = 'http://www.w3.org/1999/xhtml'

/** Image types every browser draws. EMF/WMF/TIFF are named in a placeholder instead. */
const DRAWABLE = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml', 'image/avif', 'image/x-icon'])

const FORMAT_NAMES: Record<string, string> = {
  'image/x-emf': 'EMF picture',
  'image/emf': 'EMF picture',
  'image/x-wmf': 'WMF picture',
  'image/wmf': 'WMF picture',
  'image/tiff': 'TIFF picture',
}

export function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const n = (v: number) => {
  const r = Math.round(v * 100) / 100
  return Object.is(r, -0) ? '0' : String(r)
}

/** A font family name safe inside a CSS string in a style attribute. */
const cssFont = (name: string) => `"${name.replace(/["'\\;{}<>()\n\r]/g, '')}"`

function fontStack(fonts: string[]): string {
  return [...fonts.map(cssFont), 'sans-serif'].join(',')
}

type Defs = { out: string[]; next: () => string }

function newDefs(prefix: string): Defs {
  let i = 0
  return { out: [], next: () => `${prefix}-${++i}` }
}

// ---------------------------------------------------------------------------
// Paint

function shade(c: Rgba, mode: BuiltPath['fill']): Rgba {
  const f = mode === 'darken' ? 0.6 : mode === 'darkenLess' ? 0.8 : null
  if (f !== null) return { r: Math.round(c.r * f), g: Math.round(c.g * f), b: Math.round(c.b * f), a: c.a }
  const l = mode === 'lighten' ? 0.4 : mode === 'lightenLess' ? 0.2 : 0
  return { r: Math.round(c.r + (255 - c.r) * l), g: Math.round(c.g + (255 - c.g) * l), b: Math.round(c.b + (255 - c.b) * l), a: c.a }
}

function colorAttrs(kind: 'fill' | 'stroke', c: Rgba): string {
  const base = `${kind}="${toCss({ ...c, a: 1 })}"`
  return c.a < 1 ? `${base} ${kind}-opacity="${n(c.a)}"` : base
}

function gradientDef(fill: Extract<RFill, { kind: 'gradient' }>, defs: Defs, w: number, h: number, mode: BuiltPath['fill']): string {
  const id = defs.next()
  const stops = fill.stops
    .map((s) => {
      const c = shade(s.color, mode)
      return `<stop offset="${n(s.pos)}" stop-color="${toCss({ ...c, a: 1 })}"${c.a < 1 ? ` stop-opacity="${n(c.a)}"` : ''}/>`
    })
    .join('')
  if (fill.linear || !fill.path) {
    const angle = fill.linear?.angle ?? 0
    if (fill.linear?.scaled) {
      // Scaled: the angle is taken in the unit square, then stretched with the shape.
      defs.out.push(`<linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="0" y1="0.5" x2="1" y2="0.5" gradientTransform="rotate(${n(angle)} 0.5 0.5)">${stops}</linearGradient>`)
    } else {
      // Unscaled: the angle is the real angle on the shape; the gradient line spans the shape's projection.
      const r = (angle * Math.PI) / 180
      const half = (Math.abs(w * Math.cos(r)) + Math.abs(h * Math.sin(r))) / 2
      const cx = w / 2
      const cy = h / 2
      const dx = Math.cos(r) * half
      const dy = Math.sin(r) * half
      defs.out.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(cx - dx)}" y1="${n(cy - dy)}" x2="${n(cx + dx)}" y2="${n(cy + dy)}">${stops}</linearGradient>`)
    }
  } else {
    // Path gradients (circle/rect/shape) radiate from the focus rectangle's centre; stop 0 is the centre.
    const fx = (fill.focus.l + (1 - fill.focus.r)) / 2
    const fy = (fill.focus.t + (1 - fill.focus.b)) / 2
    const radius = Math.max(Math.hypot(fx, fy), Math.hypot(1 - fx, fy), Math.hypot(fx, 1 - fy), Math.hypot(1 - fx, 1 - fy))
    defs.out.push(`<radialGradient id="${id}" gradientUnits="objectBoundingBox" cx="${n(fx)}" cy="${n(fy)}" r="${n(radius)}">${stops}</radialGradient>`)
  }
  return id
}

const PCT: Record<string, number> = { pct5: 5, pct10: 10, pct20: 20, pct25: 25, pct30: 30, pct40: 40, pct50: 50, pct60: 60, pct70: 70, pct75: 75, pct80: 80, pct90: 90 }
const hLines = (t: number) => (fg: string) => `<rect x="0" y="0" width="8" height="${t}" fill="${fg}"/>`
const vLines = (t: number) => (fg: string) => `<rect x="0" y="0" width="${t}" height="8" fill="${fg}"/>`
const dn = (t: number) => (fg: string) => `<path d="M0 0L8 8M-2 6L2 10M6 -2L10 2" stroke="${fg}" stroke-width="${t}"/>`
const up = (t: number) => (fg: string) => `<path d="M0 8L8 0M-2 2L2 -2M6 10L10 6" stroke="${fg}" stroke-width="${t}"/>`
const grid = (fg: string) => `<path d="M0 0.5H8M0.5 0V8" stroke="${fg}" stroke-width="1"/>`
const diagGrid = (fg: string) => `<path d="M0 0L8 8M8 0L0 8" stroke="${fg}" stroke-width="1"/>`
const check = (fg: string) => `<rect x="0" y="0" width="4" height="4" fill="${fg}"/><rect x="4" y="4" width="4" height="4" fill="${fg}"/>`
const dots = (fg: string) => `<rect x="0" y="0" width="1" height="1" fill="${fg}"/><rect x="4" y="4" width="1" height="1" fill="${fg}"/>`
/**
 * ST_PresetPatternVal on an 8 × 8 tile. The textured presets (bricks, weave,
 * shingle, …) are drawn as a checker in their colours; named in data-preset.
 */
const PATTERNS: Record<string, (fg: string) => string> = {
  horz: hLines(2), ltHorz: hLines(1), narHorz: hLines(1), dkHorz: hLines(3), dashHorz: hLines(1),
  vert: vLines(2), ltVert: vLines(1), narVert: vLines(1), dkVert: vLines(3), dashVert: vLines(1),
  dnDiag: dn(1.2), ltDnDiag: dn(1.2), dkDnDiag: dn(2.5), wdDnDiag: dn(2.5), dashDnDiag: dn(1.2),
  upDiag: up(1.2), ltUpDiag: up(1.2), dkUpDiag: up(2.5), wdUpDiag: up(2.5), dashUpDiag: up(1.2),
  cross: grid, smGrid: grid, lgGrid: grid, diagCross: diagGrid, openDmnd: diagGrid,
  smCheck: check, lgCheck: check, dotGrid: dots, dotDmnd: dots, smConfetti: dots, lgConfetti: dots,
}

/** ST_PresetPatternVal drawn on an 8 × 8 tile. */
function patternDef(fill: Extract<RFill, { kind: 'pattern' }>, defs: Defs): string {
  const id = defs.next()
  const fg = toCss({ ...fill.fg, a: 1 })
  const bg = toCss({ ...fill.bg, a: 1 })
  const p = fill.preset
  const pct = PCT[p]
  const mark = pct !== undefined ? null : (PATTERNS[p] ?? check)
  const side = pct !== undefined ? Math.max(0.5, 4 * Math.sqrt(pct / 100)) : 0
  const marks =
    mark === null
      ? `<rect x="0" y="0" width="${n(side)}" height="${n(side)}" fill="${fg}"/><rect x="4" y="4" width="${n(side)}" height="${n(side)}" fill="${fg}"/>`
      : mark(fg)
  defs.out.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="8" height="8" data-preset="${escAttr(p)}"><rect width="8" height="8" fill="${bg}"/>${marks}</pattern>`)
  return id
}

/** The fill attributes for a path; image fills are drawn separately (clipped <image>). */
function paint(kind: 'fill' | 'stroke', fill: RFill, defs: Defs, w: number, h: number, mode: BuiltPath['fill'] = 'norm'): string {
  switch (fill.kind) {
    case 'none':
    case 'image':
      return `${kind}="none"`
    case 'solid':
      return colorAttrs(kind, shade(fill.color, mode))
    case 'gradient':
      return `${kind}="url(#${gradientDef(fill, defs, w, h, mode)})"`
    case 'pattern':
      return `${kind}="url(#${patternDef(fill, defs)})"`
  }
}

const DASHES: Record<string, number[]> = {
  dot: [1, 3],
  dash: [4, 3],
  lgDash: [8, 3],
  dashDot: [4, 3, 1, 3],
  lgDashDot: [8, 3, 1, 3],
  lgDashDotDot: [8, 3, 1, 3, 1, 3],
  sysDash: [3, 1],
  sysDot: [1, 1],
  sysDashDot: [3, 1, 1, 1],
  sysDashDotDot: [3, 1, 1, 1, 1, 1],
}

const END_SIZE: Record<string, number> = { sm: 2, med: 3, lg: 5 }

function markerDef(end: LineEnd, color: string, defs: Defs): string | null {
  if (end.type === 'none') return null
  const id = defs.next()
  const w = END_SIZE[end.w] ?? 3
  const len = END_SIZE[end.len] ?? 3
  const shapes: Record<string, string> = {
    triangle: `<path d="M0 0L10 5L0 10Z" fill="${color}"/>`,
    stealth: `<path d="M0 0L10 5L0 10L3 5Z" fill="${color}"/>`,
    diamond: `<path d="M0 5L5 0L10 5L5 10Z" fill="${color}"/>`,
    oval: `<ellipse cx="5" cy="5" rx="5" ry="5" fill="${color}"/>`,
    arrow: `<path d="M0 0L10 5L0 10" fill="none" stroke="${color}" stroke-width="1.5"/>`,
  }
  const body = shapes[end.type] ?? shapes.triangle!
  const refX = end.type === 'diamond' || end.type === 'oval' ? 5 : 9
  defs.out.push(`<marker id="${id}" viewBox="0 0 10 10" refX="${refX}" refY="5" markerUnits="strokeWidth" markerWidth="${len}" markerHeight="${w}" orient="auto-start-reverse" overflow="visible">${body}</marker>`)
  return id
}

function strokeAttrs(line: RLine, defs: Defs, w: number, h: number, open: boolean): string {
  let s = `${paint('stroke', line.fill, defs, w, h)} stroke-width="${n(line.width)}" stroke-linecap="${line.cap}" stroke-linejoin="${line.join}"`
  const pattern = line.custDash ? line.custDash.flatMap((d) => [d.d / 100000, d.sp / 100000]) : DASHES[line.dash]
  if (pattern) s += ` stroke-dasharray="${pattern.map((v) => n(v * line.width)).join(' ')}"`
  if (open && line.fill.kind === 'solid') {
    const color = toCss({ ...line.fill.color, a: 1 })
    const head = line.head ? markerDef(line.head, color, defs) : null
    const tail = line.tail ? markerDef(line.tail, color, defs) : null
    if (head) s += ` marker-start="url(#${head})"`
    if (tail) s += ` marker-end="url(#${tail})"`
  }
  return s
}

// ---------------------------------------------------------------------------
// Frames

function frameTransform(f: Frame): string {
  let t = `translate(${n(f.x)} ${n(f.y)})`
  if (f.rot) t += ` rotate(${n(f.rot)} ${n(f.w / 2)} ${n(f.h / 2)})`
  return t
}

function flipTransform(f: Frame): string {
  const parts: string[] = []
  if (f.flipH) parts.push(`translate(${n(f.w)} 0) scale(-1 1)`)
  if (f.flipV) parts.push(`translate(0 ${n(f.h)}) scale(1 -1)`)
  return parts.join(' ')
}

function label(text: string, w: number, h: number, kind: 'placeholder' | 'badge'): string {
  if (kind === 'badge') {
    return `<foreignObject x="0" y="0" width="${n(Math.max(w, 1))}" height="${n(Math.max(h, 1))}" overflow="visible" class="pptx-badge"><div xmlns="${XHTML}" style="display:flex;justify-content:flex-start;align-items:flex-start;width:100%;height:100%"><span style="font:600 11px system-ui,sans-serif;background:rgba(255,255,255,.9);color:#444;border:1px solid #bbb;border-radius:3px;padding:1px 4px;white-space:nowrap">${escText(text)}</span></div></foreignObject>`
  }
  const size = Math.max(8, Math.min(18, h / 4, w / 10))
  return (
    `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" fill="rgba(128,128,128,0.08)" stroke="#888" stroke-width="1" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>` +
    `<foreignObject x="0" y="0" width="${n(w)}" height="${n(h)}"><div xmlns="${XHTML}" style="display:flex;align-items:center;justify-content:center;text-align:center;width:100%;height:100%;padding:4px;box-sizing:border-box;font:500 ${n(size)}px system-ui,sans-serif;color:#555;overflow:hidden">${escText(text)}</div></foreignObject>`
  )
}

// ---------------------------------------------------------------------------
// Text

/** ST_TextUnderlineType → CSS decoration style. */
const UNDERLINE: Record<string, { style: string; heavy: boolean }> = {
  sng: { style: 'solid', heavy: false },
  words: { style: 'solid', heavy: false },
  heavy: { style: 'solid', heavy: true },
  dbl: { style: 'double', heavy: false },
  dotted: { style: 'dotted', heavy: false },
  dottedHeavy: { style: 'dotted', heavy: true },
  dash: { style: 'dashed', heavy: false },
  dashHeavy: { style: 'dashed', heavy: true },
  dashLong: { style: 'dashed', heavy: false },
  dashLongHeavy: { style: 'dashed', heavy: true },
  dotDash: { style: 'dashed', heavy: false },
  dotDashHeavy: { style: 'dashed', heavy: true },
  dotDotDash: { style: 'dashed', heavy: false },
  dotDotDashHeavy: { style: 'dashed', heavy: true },
  wavy: { style: 'wavy', heavy: false },
  wavyHeavy: { style: 'wavy', heavy: true },
  wavyDbl: { style: 'wavy', heavy: false },
}

function runStyle(r: RRun): string {
  const s: string[] = [`font-family:${fontStack(r.fonts)}`]
  let size = r.size
  if (r.baseline !== 0) size = (size * 2) / 3
  s.push(`font-size:${n(size)}px`)
  if (r.bold) s.push('font-weight:700')
  if (r.italic) s.push('font-style:italic')
  const deco: string[] = []
  if (r.underline) deco.push('underline')
  if (r.strike) deco.push('line-through')
  if (deco.length) {
    s.push(`text-decoration-line:${deco.join(' ')}`)
    const u = UNDERLINE[r.underline ?? ''] ?? { style: 'solid', heavy: false }
    const style = r.strike === 'dblStrike' ? 'double' : u.style
    if (style !== 'solid') s.push(`text-decoration-style:${style}`)
    if (u.heavy) s.push('text-decoration-thickness:0.12em')
  }
  if (r.baseline !== 0) s.push(`vertical-align:${n((r.baseline / 100) * r.size)}px`)
  if (r.caps === 'small') s.push('font-variant:small-caps')
  if (r.caps === 'all') s.push('text-transform:uppercase')
  if (r.spacing) s.push(`letter-spacing:${n(r.spacing)}px`)
  if (r.highlight) s.push(`background-color:${toCss(r.highlight)}`)
  s.push(textPaint(r.fill))
  return s.join(';')
}

function textPaint(fill: RFill): string {
  switch (fill.kind) {
    case 'solid':
      return `color:${toCss(fill.color)}`
    case 'gradient': {
      const angle = (fill.linear?.angle ?? 0) + 90
      const stops = fill.stops.map((st) => `${toCss(st.color)} ${n(st.pos * 100)}%`).join(',')
      return `color:transparent;background-image:linear-gradient(${n(angle)}deg,${stops});-webkit-background-clip:text;background-clip:text`
    }
    case 'pattern':
      return `color:${toCss(fill.fg)}`
    case 'none':
    case 'image':
      return 'color:transparent'
  }
}

function spacingCss(s: RParagraph['lineSpacing'], em: number): string {
  return 'pct' in s ? n(s.pct * em) + 'em' : n(s.px) + 'px'
}

function paragraphHtml(p: RParagraph, first: boolean, opts: RenderOptions): string {
  const sizes = p.runs.filter((r) => r.text.length > 0).map((r) => r.size)
  const size = sizes.length ? Math.max(...sizes) : p.endSize
  const style: string[] = [
    'margin:0',
    `font-size:${n(size)}px`,
    `text-align:${p.align === 'ctr' ? 'center' : p.align === 'r' ? 'right' : p.align === 'just' || p.align === 'dist' || p.align === 'thaiDist' || p.align === 'justLow' ? 'justify' : 'left'}`,
    `line-height:${'pct' in p.lineSpacing ? n(p.lineSpacing.pct * 1.2) : n(p.lineSpacing.px) + 'px'}`,
  ]
  if (p.rtl) style.push('direction:rtl')
  const start = p.rtl ? 'right' : 'left'
  const end = p.rtl ? 'left' : 'right'
  if (p.marL) style.push(`padding-${start}:${n(p.marL)}px`)
  if (p.marR) style.push(`padding-${end}:${n(p.marR)}px`)
  if (p.indent) style.push(`text-indent:${n(p.indent)}px`)
  // PowerPoint does not put space before the first paragraph of a text body.
  if (!first) style.push(`margin-top:${spacingCss(p.spaceBefore, 1.2)}`)
  style.push(`margin-bottom:${spacingCss(p.spaceAfter, 1.2)}`)
  let html = ''
  if (p.bullet) {
    const b = p.bullet
    const bs = [`display:inline-block`, `text-indent:0`, `font-family:${fontStack(b.fonts)}`, `font-size:${n(b.size)}px`, textPaint(b.color), 'white-space:pre']
    if (p.indent < 0) bs.push(`min-width:${n(-p.indent)}px`)
    else bs.push(`margin-${end}:0.5em`)
    html += `<span class="pptx-bullet" aria-hidden="true" style="${escAttr(bs.join(';'))}">${escText(b.text)}</span>`
  }
  for (const r of p.runs) {
    if (r.isBreak) {
      html += '<br/>'
      continue
    }
    if (!r.text) continue
    const span = `<span style="${escAttr(runStyle(r))}">${escText(r.text)}</span>`
    if (r.link && opts.links) {
      if (r.link.kind === 'url') html += `<a href="${escAttr(r.link.href)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:inherit">${span}</a>`
      else if (r.link.kind === 'slide') html += `<span role="link" tabindex="0" data-slide-link="${r.link.index}" style="cursor:pointer">${span}</span>`
      else html += `<span title="${escAttr(`Link not supported: ${r.link.what}`)}">${span}</span>`
    } else html += span
  }
  if (!p.runs.some((r) => r.text.length > 0 || r.isBreak)) html += '<br/>'
  return `<p style="${escAttr(style.join(';'))}">${html}</p>`
}

function paragraphsHtml(paragraphs: RParagraph[], opts: RenderOptions): string {
  return paragraphs.map((p, i) => paragraphHtml(p, i === 0, opts)).join('')
}

function textHtml(t: RText, opts: RenderOptions): string {
  const justify = t.anchor === 'ctr' || t.anchor === 'just' || t.anchor === 'dist' ? 'center' : t.anchor === 'b' ? 'flex-end' : 'flex-start'
  const outer: string[] = ['width:100%', 'height:100%', 'display:flex', 'flex-direction:column', `justify-content:${justify}`, 'box-sizing:border-box', 'overflow:visible', 'tab-size:96px']
  if (t.vert === 'eaVert' || t.vert === 'wordArtVert' || t.vert === 'wordArtVertRtl') outer.push('writing-mode:vertical-rl')
  if (t.vert === 'mongolianVert') outer.push('writing-mode:vertical-lr')
  const inner: string[] = [`white-space:${t.wrap ? 'pre-wrap' : 'pre'}`, 'overflow-wrap:break-word']
  if (!t.wrap) {
    // No wrapping: lines run past the box; the block stays put by its alignment.
    const align = t.paragraphs[0]?.align
    outer.push(`align-items:${align === 'ctr' ? 'center' : align === 'r' ? 'flex-end' : 'flex-start'}`)
    inner.push('width:max-content')
  } else if (t.anchorCtr) {
    outer.push('align-items:center')
    inner.push('width:fit-content', 'max-width:100%')
  }
  if (t.columns > 1) inner.push(`column-count:${t.columns}`, 'column-gap:0')
  return `<div xmlns="${XHTML}" class="pptx-text" style="${escAttr(outer.join(';'))}"><div style="${escAttr(inner.join(';'))}">${paragraphsHtml(t.paragraphs, opts)}</div></div>`
}

function textSvg(t: RText, frame: Frame, opts: RenderOptions): string {
  const { x, y, w, h } = t.box
  const cx = x + w / 2
  const cy = y + h / 2
  let rot = t.rot
  if (frame.flipV) rot += 180
  let fx = x
  let fy = y
  let fw = w
  let fh = h
  if (t.vert === 'vert' || t.vert === 'vert270') {
    rot += t.vert === 'vert' ? 90 : 270
    fw = h
    fh = w
    fx = cx - fw / 2
    fy = cy - fh / 2
  }
  const fo = `<foreignObject x="${n(fx)}" y="${n(fy)}" width="${n(Math.max(fw, 0.01))}" height="${n(Math.max(fh, 0.01))}" overflow="visible">${textHtml(t, opts)}</foreignObject>`
  return rot % 360 ? `<g transform="rotate(${n(rot)} ${n(cx)} ${n(cy)})">${fo}</g>` : fo
}

// ---------------------------------------------------------------------------
// Pictures

function imageMarkup(fill: Extract<RFill, { kind: 'image' }>, w: number, h: number, opts: RenderOptions, defs: Defs): { svg: string; problem: string | null } {
  const ref: ImageRef | null = fill.image
  if (!ref) return { svg: '', problem: 'Picture without an image' }
  if (ref.kind === 'external') return { svg: '', problem: 'Linked picture (not in the file)' }
  if (ref.kind === 'missing') return { svg: '', problem: 'Missing picture' }
  if (!DRAWABLE.has(ref.contentType.toLowerCase())) return { svg: '', problem: `${FORMAT_NAMES[ref.contentType.toLowerCase()] ?? `Picture (${ref.contentType})`} — not shown yet` }
  const src = opts.media(ref.part)
  if (!src) return { svg: '', problem: 'Picture could not be loaded' }
  const opacity = fill.alpha < 1 ? ` opacity="${n(fill.alpha)}"` : ''
  if (fill.tile && src.width && src.height) {
    const id = defs.next()
    const tw = (src.width * fill.tile.sx) / 100000
    const th = (src.height * fill.tile.sy) / 100000
    defs.out.push(
      `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${n(fill.tile.tx / 9525)}" y="${n(fill.tile.ty / 9525)}" width="${n(tw)}" height="${n(th)}"><image href="${escAttr(src.url)}" width="${n(tw)}" height="${n(th)}" preserveAspectRatio="none"/></pattern>`,
    )
    return { svg: `<rect width="${n(w)}" height="${n(h)}" fill="url(#${id})"${opacity}/>`, problem: null }
  }
  const rx = fill.inset.l * w
  const ry = fill.inset.t * h
  const rw = w * (1 - fill.inset.l - fill.inset.r)
  const rh = h * (1 - fill.inset.t - fill.inset.b)
  const iw = rw / Math.max(1e-6, 1 - fill.crop.l - fill.crop.r)
  const ih = rh / Math.max(1e-6, 1 - fill.crop.t - fill.crop.b)
  const ix = rx - fill.crop.l * iw
  const iy = ry - fill.crop.t * ih
  return { svg: `<image href="${escAttr(src.url)}" x="${n(ix)}" y="${n(iy)}" width="${n(iw)}" height="${n(ih)}" preserveAspectRatio="none"${opacity}/>`, problem: null }
}

function clipDef(geometry: BuiltGeometry, defs: Defs): string {
  const id = defs.next()
  defs.out.push(`<clipPath id="${id}">${geometry.paths.map((p) => `<path d="${p.d}"/>`).join('')}</clipPath>`)
  return id
}

// ---------------------------------------------------------------------------
// Nodes

function shapePaths(geometry: BuiltGeometry, fill: RFill, line: RLine | null, w: number, h: number, defs: Defs): string {
  let out = ''
  for (const p of geometry.paths) {
    const filled = p.fill !== 'none' && fill.kind !== 'none' && fill.kind !== 'image'
    const stroked = p.stroke && line !== null
    if (!filled && !stroked) continue
    const open = !/Z\s*$/i.test(p.d)
    const f = filled ? paint('fill', fill, defs, w, h, p.fill) : 'fill="none"'
    const s = stroked ? ` ${strokeAttrs(line!, defs, w, h, open)}` : ''
    out += `<path d="${p.d}" ${f}${s}/>`
  }
  return out
}

function nodeSvg(node: RNode, opts: RenderOptions, defs: Defs): string {
  switch (node.kind) {
    case 'group':
      return `<g data-shape="${escAttr(node.name)}">${node.children.map((c) => nodeSvg(c, opts, defs)).join('')}</g>`
    case 'shape': {
      const { frame: f } = node
      let inner = ''
      if (node.fill.kind === 'image') {
        const clip = clipDef(node.geometry, defs)
        const img = imageMarkup(node.fill, f.w, f.h, opts, defs)
        inner += img.problem ? label(img.problem, f.w, f.h, 'placeholder') : `<g clip-path="url(#${clip})">${img.svg}</g>`
      }
      inner += shapePaths(node.geometry, node.fill, node.line, f.w, f.h, defs)
      const flip = flipTransform(f)
      let out = flip ? `<g transform="${flip}">${inner}</g>` : inner
      if (node.unknownGeometry) out += label(`${node.unknownGeometry} — not drawn yet`, f.w, f.h, 'placeholder')
      if (node.text) out += textSvg(node.text, f, opts)
      return `<g transform="${frameTransform(f)}" data-shape="${escAttr(node.name)}"${node.placeholder ? ` data-placeholder="${escAttr(node.placeholder)}"` : ''}>${out}</g>`
    }
    case 'picture': {
      const { frame: f } = node
      const img = imageMarkup(node.image, f.w, f.h, opts, defs)
      let inner: string
      if (img.problem) inner = label(img.problem, f.w, f.h, 'placeholder')
      else {
        const clip = clipDef(node.geometry, defs)
        const flip = flipTransform(f)
        const pic = `<g clip-path="url(#${clip})">${img.svg}</g>`
        inner = flip ? `<g transform="${flip}">${pic}</g>` : pic
      }
      if (node.line) inner += shapePaths(node.geometry, { kind: 'none' }, node.line, f.w, f.h, defs)
      if (node.media) inner += label(node.media === 'video' ? 'Video — playback not supported yet' : 'Audio — playback not supported yet', f.w, f.h, 'badge')
      const alt = node.descr ? `<title>${escText(node.descr)}</title>` : ''
      return `<g transform="${frameTransform(f)}" data-shape="${escAttr(node.name)}" role="img"${node.descr ? ` aria-label="${escAttr(node.descr)}"` : ''}>${alt}${inner}</g>`
    }
    case 'table':
      return `<g transform="${frameTransform(node.frame)}" data-shape="${escAttr(node.name)}">${tableSvg(node.table, node.frame, opts)}</g>`
    case 'placeholder':
      return `<g transform="${frameTransform(node.frame)}" data-shape="${escAttr(node.name)}" data-not-shown="">${label(node.label, node.frame.w, node.frame.h, 'placeholder')}</g>`
  }
}

function borderCss(line: RLine | null): string {
  if (!line) return 'none'
  const color = line.fill.kind === 'solid' ? toCss(line.fill.color) : line.fill.kind === 'gradient' ? toCss(line.fill.stops[0]!.color) : 'transparent'
  const style = line.dash === 'solid' ? 'solid' : line.dash === 'dot' || line.dash === 'sysDot' ? 'dotted' : 'dashed'
  return `${n(Math.max(line.width, 0.5))}px ${style} ${color}`
}

function cellBackground(fill: RFill): string {
  switch (fill.kind) {
    case 'solid':
      return `background:${toCss(fill.color)}`
    case 'gradient':
      return `background:linear-gradient(${n((fill.linear?.angle ?? 0) + 90)}deg,${fill.stops.map((s) => `${toCss(s.color)} ${n(s.pos * 100)}%`).join(',')})`
    case 'pattern':
      return `background:${toCss(fill.bg)}`
    default:
      return ''
  }
}

function cellHtml(c: RCell, opts: RenderOptions): string {
  const st = [
    cellBackground(c.fill),
    `border-left:${borderCss(c.borders.l)}`,
    `border-right:${borderCss(c.borders.r)}`,
    `border-top:${borderCss(c.borders.t)}`,
    `border-bottom:${borderCss(c.borders.b)}`,
    `padding:${n(c.insets.t)}px ${n(c.insets.r)}px ${n(c.insets.b)}px ${n(c.insets.l)}px`,
    `vertical-align:${c.anchor === 'ctr' ? 'middle' : c.anchor === 'b' ? 'bottom' : 'top'}`,
    'white-space:pre-wrap',
    'overflow-wrap:break-word',
  ].filter(Boolean)
  if (c.vert === 'eaVert' || c.vert === 'wordArtVert') st.push('writing-mode:vertical-rl')
  const span = `${c.colSpan > 1 ? ` colspan="${c.colSpan}"` : ''}${c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : ''}`
  return `<td${span} style="${escAttr(st.join(';'))}">${paragraphsHtml(c.paragraphs, opts)}</td>`
}

function tableSvg(t: RTable, frame: Frame, opts: RenderOptions): string {
  const width = t.cols.reduce((s, c) => s + c, 0)
  const cols = t.cols.map((c) => `<col style="width:${n(c)}px"/>`).join('')
  const rows = t.rows.map((r) => `<tr style="height:${n(r.h)}px">${r.cells.filter((c) => !c.covered).map((c) => cellHtml(c, opts)).join('')}</tr>`).join('')
  const table = `<table style="border-collapse:collapse;table-layout:fixed;width:${n(width)}px;tab-size:96px"><colgroup>${cols}</colgroup><tbody>${rows}</tbody></table>`
  const fo = `<foreignObject x="0" y="0" width="${n(Math.max(width, frame.w))}" height="${n(Math.max(frame.h, 1))}" overflow="visible"><div xmlns="${XHTML}" class="pptx-table">${table}</div></foreignObject>`
  return t.missingStyle ? fo + label(`Table style ${t.missingStyle} is not in the file`, frame.w, frame.h, 'badge') : fo
}

/** The slide as an SVG document string. */
export function renderSlideSvg(slide: RSlide, opts: RenderOptions): string {
  const defs = newDefs(opts.idPrefix)
  const W = slide.width
  const H = slide.height
  let bg: string
  if (slide.background.kind === 'image') {
    const img = imageMarkup(slide.background, W, H, opts, defs)
    bg = img.problem ? `<rect width="${n(W)}" height="${n(H)}" fill="#fff"/>${label(`Background: ${img.problem}`, W, H / 8, 'badge')}` : img.svg
  } else bg = `<rect width="${n(W)}" height="${n(H)}" ${paint('fill', slide.background, defs, W, H)}/>`
  const body = slide.nodes.map((node) => nodeSvg(node, opts, defs)).join('')
  const notShown = slide.notShown.length ? label(`Not shown: ${slide.notShown.join(', ')}`, W, 24, 'badge') : ''
  const aria = opts.label ? ` role="img" aria-label="${escAttr(opts.label)}"` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(W)} ${n(H)}" preserveAspectRatio="xMidYMid meet" class="pptx-slide" data-slide="${slide.index + 1}"${aria} style="display:block;width:100%;height:100%;overflow:hidden">` +
    `<defs>${defs.out.join('')}</defs>${bg}${body}${notShown}</svg>`
  )
}
