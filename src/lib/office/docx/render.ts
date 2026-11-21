import type { Block, DocxDocument, Inline, Paragraph, PlaceholderInline, Table, TableCell } from './model'
import type { Border, EdgeBorders, ParagraphProps, RunProps } from './properties'
import { fontStack } from './fonts'
import { authorColor } from './review-colors'
import { symbolChar, symbolText } from './symbols'
import { descendants, NS, wa, wc } from './xml'

/**
 * Renders the document model to DOM (browser only). Sizes are in points so
 * a page is its true size at 100%; zoom scales the page frame. Paragraphs
 * and tables come out as flow elements the paginator (./paginate.ts) places
 * on pages, measuring their rendered heights.
 */

export const PX_PER_PT = 96 / 72

/** Word's single line height relative to the font size (font ascent + descent + gap, typical of Office fonts). */
const SINGLE_LINE = 1.15
/** Auto spacing (w:beforeAutospacing / w:afterAutospacing): what Word applies, 14pt. */
export const AUTO_SPACING_PT = 14
/** Word's default font size when nothing sets one (w:sz default, §17.3.2.38). */
const DEFAULT_SIZE_PT = 10

export type RenderEnv = {
  doc: DocxDocument
  document: Document
  /** An object URL for a media part (cached by the caller), or null when it can't be shown. */
  imageUrl(part: string, contentType: string | null): string | null
  /** Values of page fields on the page being rendered (headers/footers); null outside a page. */
  pageField(code: string): string | null
}

export const HIGHLIGHT: Record<string, string> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  green: '#00ff00',
  magenta: '#ff00ff',
  red: '#ff0000',
  yellow: '#ffff00',
  white: '#ffffff',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
}

function el<K extends keyof HTMLElementTagNameMap>(env: RenderEnv, tag: K, className?: string): HTMLElementTagNameMap[K] {
  const e = env.document.createElement(tag)
  if (className) e.className = className
  return e
}

// ---------------------------------------------------------------- runs

/** ST_Underline → CSS line style and weight. */
export const UNDERLINE: Record<string, { style: string; heavy: boolean }> = {
  single: { style: 'solid', heavy: false },
  words: { style: 'solid', heavy: false },
  double: { style: 'double', heavy: false },
  thick: { style: 'solid', heavy: true },
  dotted: { style: 'dotted', heavy: false },
  dottedHeavy: { style: 'dotted', heavy: true },
  dash: { style: 'dashed', heavy: false },
  dashedHeavy: { style: 'dashed', heavy: true },
  dashLong: { style: 'dashed', heavy: false },
  dashLongHeavy: { style: 'dashed', heavy: true },
  dotDash: { style: 'dashed', heavy: false },
  dashDotHeavy: { style: 'dashed', heavy: true },
  dotDotDash: { style: 'dashed', heavy: false },
  dashDotDotHeavy: { style: 'dashed', heavy: true },
  wave: { style: 'wavy', heavy: false },
  wavyHeavy: { style: 'wavy', heavy: true },
  wavyDouble: { style: 'wavy', heavy: false },
}

const isCs = (r: RunProps) => r.rtl === true || r.cs === true

export function runCss(r: RunProps, env: Pick<RenderEnv, 'doc'>): string {
  const cs = isCs(r)
  const css: string[] = []
  const fonts = r.fonts ?? {}
  const primary = cs ? (fonts.cs ?? fonts.ascii) : (fonts.ascii ?? fonts.hAnsi)
  css.push(`font-family:${fontStack(primary, fonts.eastAsia, env.doc.fonts)}`)
  const size = (cs ? (r.sizeCsPt ?? r.sizePt) : r.sizePt) ?? DEFAULT_SIZE_PT
  const scripted = r.vertAlign === 'superscript' || r.vertAlign === 'subscript'
  css.push(`font-size:${scripted ? (size * 2) / 3 : size}pt`)
  if (scripted) css.push(`vertical-align:${r.vertAlign === 'superscript' ? 'super' : 'sub'}`)
  const bold = cs ? (r.boldCs ?? r.bold) : r.bold
  const italic = cs ? (r.italicCs ?? r.italic) : r.italic
  css.push(`font-weight:${bold ? 700 : 400}`)
  css.push(`font-style:${italic ? 'italic' : 'normal'}`)
  const lines: string[] = []
  const u = r.underline
  if (u && u !== 'none') lines.push('underline')
  if (r.strike || r.doubleStrike) lines.push('line-through')
  if (lines.length) {
    css.push(`text-decoration-line:${lines.join(' ')}`)
    const look = u && u !== 'none' ? (UNDERLINE[u] ?? UNDERLINE.single!) : r.doubleStrike ? { style: 'double', heavy: false } : UNDERLINE.single!
    css.push(`text-decoration-style:${look.style}`)
    if (look.heavy) css.push('text-decoration-thickness:0.12em')
    if (r.underlineColor) css.push(`text-decoration-color:${r.underlineColor}`)
    css.push('text-decoration-skip-ink:none')
  }
  if (r.caps) css.push('text-transform:uppercase')
  if (r.smallCaps) css.push('font-variant-caps:small-caps')
  if (r.color) css.push(`color:${r.color}`)
  const hl = r.highlight && r.highlight !== 'none' ? HIGHLIGHT[r.highlight] : undefined
  if (hl) css.push(`background-color:${hl}`)
  else if (r.shading) css.push(`background-color:${r.shading}`)
  if (r.spacingPt) css.push(`letter-spacing:${r.spacingPt}pt`)
  if (r.positionPt) css.push(`position:relative`, `top:${-r.positionPt}pt`)
  if (r.rtl) css.push('unicode-bidi:embed', 'direction:rtl')
  if (r.border && r.border.style !== 'none') css.push(`border:${borderCss(r.border)}`)
  return css.join(';')
}

function markCss(r: RunProps, env: Pick<RenderEnv, 'doc'>): string {
  const fonts = r.fonts ?? {}
  const cs = isCs(r)
  const size = (cs ? (r.sizeCsPt ?? r.sizePt) : r.sizePt) ?? DEFAULT_SIZE_PT
  return `font-family:${fontStack(cs ? (fonts.cs ?? fonts.ascii) : (fonts.ascii ?? fonts.hAnsi), fonts.eastAsia, env.doc.fonts)};font-size:${size}pt`
}

function runSpan(r: RunProps, env: RenderEnv): HTMLSpanElement {
  const s = el(env, 'span')
  s.style.cssText = runCss(r, env)
  const lang = isCs(r) ? (r.lang?.bidi ?? r.lang?.val) : r.lang?.val
  if (lang) s.lang = lang
  return s
}

// ---------------------------------------------------------------- borders

const BORDER_STYLE: Record<string, string> = {
  single: 'solid',
  thick: 'solid',
  double: 'double',
  triple: 'double',
  dotted: 'dotted',
  dashed: 'dashed',
  dashSmallGap: 'dashed',
  dotDash: 'dashed',
  dotDotDash: 'dashed',
  wave: 'solid',
  doubleWave: 'double',
  thinThickSmallGap: 'double',
  thickThinSmallGap: 'double',
  thinThickThinSmallGap: 'double',
  thinThickMediumGap: 'double',
  thickThinMediumGap: 'double',
  thinThickThinMediumGap: 'double',
  thinThickLargeGap: 'double',
  thickThinLargeGap: 'double',
  thinThickThinLargeGap: 'double',
  inset: 'inset',
  outset: 'outset',
  threeDEmboss: 'ridge',
  threeDEngrave: 'groove',
}

export function borderCss(b: Border | undefined): string {
  if (!b || b.style === 'none') return 'none'
  // Art borders (apples, stars, …) are drawn as plain lines.
  const style = BORDER_STYLE[b.style] ?? 'solid'
  // A double line needs room for two strokes and a gap.
  const width = style === 'double' ? Math.max(b.widthPt, 2.25) : Math.max(b.widthPt, 0.5)
  return `${width}pt ${style} ${b.color ?? '#000000'}`
}

// ---------------------------------------------------------------- inlines

const SAFE_SCHEMES = /^(https?:|mailto:|tel:)/i

function linkTo(env: RenderEnv, href: string | null, anchor: string | null, tooltip: string | null): HTMLElement {
  const a = el(env, 'a', 'docx-link')
  // The look comes from the runs (Word's Hyperlink style), not the browser's link style.
  a.style.cssText = 'color:inherit;text-decoration:none'
  if (href && SAFE_SCHEMES.test(href.trim())) {
    a.href = href.trim()
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
  } else if (anchor) {
    a.href = `#${encodeURIComponent(anchor)}`
    a.dataset.anchor = anchor
  } else if (href) {
    // A link we won't open (file:, javascript:, a relative path): shown, not followable.
    a.title = `Link not opened: ${href}`
  }
  if (tooltip) a.title = tooltip
  return a
}

function box(env: RenderEnv, i: Pick<PlaceholderInline, 'label' | 'widthPt' | 'heightPt'>, block = false): HTMLElement {
  const b = el(env, block ? 'div' : 'span', 'docx-placeholder docx-atom')
  b.dataset.testid = 'docx-placeholder'
  b.style.cssText = [
    block ? 'display:flex' : 'display:inline-flex',
    'align-items:center',
    'justify-content:center',
    'box-sizing:border-box',
    'border:1px dashed #9ca3af',
    'background:#f9fafb',
    'color:#4b5563',
    'font:9pt/1.3 system-ui, sans-serif',
    'padding:4pt 6pt',
    'text-align:center',
    'vertical-align:bottom',
    'max-width:100%',
    i.widthPt ? `width:${i.widthPt}pt` : '',
    i.heightPt ? `min-height:${Math.min(i.heightPt, 600)}pt` : '',
  ]
    .filter(Boolean)
    .join(';')
  b.textContent = i.label
  return b
}

/** A small visible note pinned on a picture or box (doesn't take room in the flow). */
function badge(env: RenderEnv, text: string): HTMLElement {
  const b = el(env, 'span', 'docx-badge')
  b.dataset.testid = 'docx-badge'
  b.style.cssText =
    'position:absolute;inset-inline-start:2pt;top:2pt;font:7.5pt/1.2 system-ui, sans-serif;background:rgba(255,255,255,.92);color:#374151;border:1px solid #d1d5db;border-radius:3pt;padding:1pt 3pt;pointer-events:none;white-space:nowrap;user-select:none'
  b.setAttribute('aria-hidden', 'false')
  b.textContent = text
  return b
}

function image(env: RenderEnv, i: Extract<Inline, { type: 'image' }>): HTMLElement {
  const url = i.part ? env.imageUrl(i.part, i.contentType) : null
  if (!url) {
    return box(env, { label: i.part ? 'Picture format not shown' : 'Picture missing from the file', widthPt: i.widthPt || null, heightPt: i.heightPt || null })
  }
  const img = el(env, 'img', 'docx-image')
  img.src = url
  img.alt = i.alt
  if (i.title) img.title = i.title
  img.draggable = false
  img.style.cssText = `display:inline-block;vertical-align:baseline;max-width:none;${i.widthPt ? `width:${i.widthPt}pt;` : ''}${i.heightPt ? `height:${i.heightPt}pt;` : ''}`
  const note = i.objectPreview ? 'Embedded object shown as its preview' : i.floating ? 'Floating picture shown in line' : null
  if (!note) return img
  const wrap = el(env, 'span', 'docx-atom')
  wrap.style.cssText = 'position:relative;display:inline-block;vertical-align:baseline;line-height:0'
  wrap.append(img, badge(env, note))
  return wrap
}

function placeholder(env: RenderEnv, i: PlaceholderInline): HTMLElement {
  if (i.what === 'rule') {
    const hr = el(env, 'span', 'docx-rule docx-atom')
    hr.style.cssText = 'display:inline-block;width:100%;vertical-align:middle;border-top:1px solid #a0a0a0;height:0'
    return hr
  }
  if (i.what === 'equation') {
    const s = el(env, 'span', 'docx-equation')
    s.style.cssText = `${runCss(i.run, env)};font-style:italic;font-family:"Cambria Math", "STIX Two Math", serif;outline:1px dashed #9ca3af;outline-offset:1pt`
    s.title = i.label
    s.dataset.testid = 'docx-equation'
    s.textContent = i.text
    return s
  }
  if (i.blocks.length > 0) {
    const wrap = el(env, 'span', 'docx-atom docx-textbox')
    wrap.style.cssText = `position:relative;display:inline-block;vertical-align:top;box-sizing:border-box;border:1px dashed #9ca3af;padding:12pt 4pt 4pt;max-width:100%;${i.widthPt ? `width:${i.widthPt}pt;` : ''}`
    wrap.append(renderFlow(i.blocks, env), badge(env, i.floating ? `${i.label} (floating, shown in line)` : i.label))
    return wrap
  }
  const b = box(env, { ...i, label: i.floating ? `${i.label} (floating)` : i.label })
  return b
}

function renderInlines(list: readonly Inline[], into: HTMLElement, env: RenderEnv) {
  let last: { run: RunProps; span: HTMLSpanElement } | null = null
  for (const i of list) {
    if (i.type !== 'text') last = null
    switch (i.type) {
      case 'text': {
        if (i.run.vanish) break
        if (last && last.run === i.run) {
          last.span.append(i.text)
          break
        }
        const s = runSpan(i.run, env)
        s.textContent = i.text
        const ids = env.doc.commentAnchors.get(i.source)
        if (ids) {
          s.classList.add('docx-comment')
          s.dataset.comments = ids.join(' ')
        }
        // Formatting changed while tracking (w:rPrChange in the run's properties).
        const change = wc(wc(i.source.parentNode as Element | null, 'rPr'), 'rPrChange')
        if (change) {
          s.classList.add('docx-format-change')
          s.style.outline = `1px dotted ${authorColor(wa(change, 'author'))}`
          s.title = `Formatting changed by ${wa(change, 'author') ?? 'an unknown author'}`
        }
        into.append(s)
        last = ids || change ? null : { run: i.run, span: s }
        break
      }
      case 'tab': {
        const s = runSpan(i.run, env)
        s.classList.add('docx-tab', 'docx-atom')
        s.style.display = 'inline-block'
        s.style.width = '0'
        s.style.height = '0'
        s.style.whiteSpace = 'nowrap'
        // Copying gives a real tab character.
        s.append('\t')
        s.style.overflow = 'hidden'
        into.append(s)
        break
      }
      case 'break':
        if (i.kind !== 'page') into.append(el(env, 'br'))
        break
      case 'image':
        into.append(image(env, i))
        break
      case 'symbol': {
        const s = runSpan(i.run, env)
        const sym = symbolChar(i.font, i.code)
        if (!sym.mapped && i.font) s.style.fontFamily = `"${i.font}", ${s.style.fontFamily}`
        s.textContent = sym.char
        into.append(s)
        break
      }
      case 'link': {
        const a = linkTo(env, i.href, i.anchor, i.tooltip)
        renderInlines(i.children, a, env)
        into.append(a)
        break
      }
      case 'field': {
        const value = i.code === 'PAGE' || i.code === 'NUMPAGES' || i.code === 'SECTIONPAGES' ? env.pageField(i.code) : null
        if (value !== null) {
          const s = runSpan(firstRun(i.children) ?? i.run, env)
          s.dataset.field = i.code
          s.textContent = value
          into.append(s)
          break
        }
        if (i.code === 'HYPERLINK') {
          const anchor = typeof i.switches.l === 'string' ? i.switches.l : null
          const a = linkTo(env, anchor ? null : (i.args[0] ?? null), anchor, typeof i.switches.o === 'string' ? i.switches.o : null)
          renderInlines(i.children, a, env)
          into.append(a)
          break
        }
        const s = el(env, 'span', 'docx-field')
        s.dataset.field = i.code
        renderInlines(i.children, s, env)
        into.append(s)
        break
      }
      case 'bookmark': {
        const s = el(env, 'span', 'docx-bookmark')
        s.dataset.bookmark = i.name
        into.append(s)
        break
      }
      case 'noteRef': {
        const s = runSpan(i.run, env)
        s.classList.add('docx-noteref')
        s.dataset.note = `${i.kind}:${i.id}`
        s.textContent = i.mark
        into.append(s)
        break
      }
      case 'noteMark': {
        const s = runSpan(i.run, env)
        s.textContent = i.mark
        into.append(s)
        break
      }
      case 'change': {
        const c = el(env, i.kind === 'insert' ? 'ins' : 'del', `docx-change docx-change-${i.kind}`)
        c.style.cssText = `color:${authorColor(i.author)};text-decoration-line:${i.kind === 'insert' ? 'underline' : 'line-through'}${i.move ? ';text-decoration-style:double' : ''}`
        const what = i.move ? (i.kind === 'insert' ? 'Moved here' : 'Moved away') : i.kind === 'insert' ? 'Inserted' : 'Deleted'
        c.title = `${what} by ${i.author ?? 'an unknown author'}${i.date ? `, ${i.date}` : ''}`
        renderInlines(i.children, c, env)
        into.append(c)
        break
      }
      case 'ruby': {
        const ruby = el(env, 'ruby')
        renderInlines(i.base, ruby, env)
        const rt = el(env, 'rt')
        renderInlines(i.text, rt, env)
        ruby.append(rt)
        into.append(ruby)
        break
      }
      case 'placeholder':
        into.append(placeholder(env, i))
        break
    }
  }
}

function firstRun(list: readonly Inline[]): RunProps | null {
  for (const i of list) {
    if (i.type === 'text' || i.type === 'tab' || i.type === 'noteRef') return i.run
    if (i.type === 'link' || i.type === 'field' || i.type === 'change') {
      const r = firstRun(i.children)
      if (r) return r
    }
  }
  return null
}

// ---------------------------------------------------------------- paragraphs

export type ParagraphFragment = {
  /** The inlines of this piece (a paragraph cut at page breaks); defaults to all. */
  inlines?: readonly Inline[]
  /** First piece: carries the list label, first-line indent and space before. */
  first?: boolean
  /** Last piece: carries the space after. */
  last?: boolean
  /** Neighbours, for w:contextualSpacing. */
  prev?: Block | null
  next?: Block | null
}

const sameStyle = (a: Block | null | undefined, b: Paragraph) => a?.type === 'paragraph' && a.props.styleId === b.props.styleId

function lineHeight(props: ParagraphProps): string {
  const line = props.spacing?.line
  if (!line) return String(SINGLE_LINE)
  if (line.rule === 'auto') return String(line.multiple * SINGLE_LINE)
  if (line.rule === 'exact') return `${line.pt}pt`
  return `max(${SINGLE_LINE}em, ${line.pt}pt)`
}

/**
 * A paragraph's own box as CSS (spacing, indents, alignment, line height,
 * direction, shading, borders and the paragraph mark's strut). Shared by the
 * paginated view and the editor's continuous layout.
 */
export function paragraphCss(
  props: ParagraphProps,
  markRun: RunProps,
  env: Pick<RenderEnv, 'doc'>,
  box: { beforePt: number; afterPt: number; firstLine: boolean },
): string {
  const ind = props.indent ?? {}
  const align = props.align ?? 'start'
  const css = [
    'margin:0',
    `margin-top:${box.beforePt}pt`,
    `margin-bottom:${box.afterPt}pt`,
    `margin-inline-start:${ind.startPt ?? 0}pt`,
    `margin-inline-end:${ind.endPt ?? 0}pt`,
    `text-indent:${box.firstLine ? (ind.firstLinePt ?? 0) : 0}pt`,
    `text-align:${align === 'distribute' ? 'justify' : align}`,
    align === 'distribute' ? 'text-align-last:justify' : '',
    `line-height:${lineHeight(props)}`,
    `direction:${props.bidi ? 'rtl' : 'ltr'}`,
    // The paragraph mark sets the line's strut (and an empty paragraph's height); everything else stays on runs.
    markCss(markRun, env),
    'white-space:pre-wrap',
    'overflow-wrap:break-word',
  ]
  if (props.shading) css.push(`background-color:${props.shading}`)
  const b = props.borders
  if (b) {
    for (const [edge, side] of [
      ['top', 'top'],
      ['bottom', 'bottom'],
      ['start', 'inline-start'],
      ['end', 'inline-end'],
    ] as const) {
      const border = b[edge]
      if (border && border.style !== 'none') css.push(`border-${side}:${borderCss(border)}`, `padding-${side}:${border.spacePt}pt`)
    }
  }
  return css.filter(Boolean).join(';')
}

const PARAGRAPH_OF = new WeakMap<HTMLElement, Paragraph>()

/** The model paragraph a rendered paragraph element shows. */
export const paragraphOf = (e: HTMLElement) => PARAGRAPH_OF.get(e)

export function renderParagraph(p: Paragraph, env: RenderEnv, frag: ParagraphFragment = {}): HTMLElement {
  const first = frag.first ?? true
  const last = frag.last ?? true
  const props = p.props
  const e = el(env, 'p', 'docx-p')
  PARAGRAPH_OF.set(e, p)
  const sp = props.spacing ?? {}
  let before = sp.beforeAuto ? AUTO_SPACING_PT : (sp.beforePt ?? 0)
  let after = sp.afterAuto ? AUTO_SPACING_PT : (sp.afterPt ?? 0)
  if (props.contextualSpacing && sameStyle(frag.prev, p)) before = 0
  if (props.contextualSpacing && sameStyle(frag.next, p)) after = 0
  if (!first) before = 0
  if (!last) after = 0
  e.style.cssText = paragraphCss(props, p.markRun, env, { beforePt: before, afterPt: after, firstLine: first })
  if (props.outlineLevel !== undefined && props.outlineLevel >= 0 && props.outlineLevel <= 8) {
    e.setAttribute('role', 'heading')
    e.setAttribute('aria-level', String(props.outlineLevel + 1))
  }
  if (props.keepNext) e.dataset.keepNext = '1'
  if (props.keepLines) e.dataset.keepLines = '1'
  if (props.widowControl) e.dataset.widow = '1'

  if (first && p.list && p.list.text !== '' && p.list.level.format !== 'none') {
    const m = runSpan(p.list.markerRun, env)
    m.classList.add('docx-marker')
    m.style.textDecorationLine = 'none'
    const font = p.list.markerRun.fonts?.ascii
    const shown = p.list.level.format === 'bullet' ? symbolText(font, p.list.text) : { text: p.list.text, mapped: false }
    if (shown.mapped) m.style.fontFamily = 'system-ui, sans-serif'
    m.textContent = shown.text
    if (p.list.unsupported.length) m.title = `Number format ${p.list.unsupported.join(', ')} shown as decimal`
    e.append(m)
    if (p.list.level.suffix === 'tab') {
      const t = runSpan(p.list.markerRun, env)
      t.classList.add('docx-tab', 'docx-atom')
      t.dataset.markerTab = '1'
      t.style.cssText += ';display:inline-block;width:0;height:0;overflow:hidden;white-space:nowrap'
      t.append('\t')
      e.append(t)
    } else if (p.list.level.suffix === 'space') e.append(' ')
  }
  renderInlines(frag.inlines ?? p.inlines, e, env)
  // The change bar in the margin (drawn by the viewer's styles).
  if (hasTrackedChange(p.source)) e.classList.add('docx-changed')
  if (!hasVisibleContent(e)) {
    // An empty paragraph still takes a line at its mark's size.
    e.append(el(env, 'br'))
  }
  return e
}

const CHANGE_ELEMENTS = ['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange', 'pPrChange']

/** Whether a paragraph holds a tracked change of any kind (text, formatting, its properties or its mark). */
export function hasTrackedChange(p: Element): boolean {
  return CHANGE_ELEMENTS.some((n) => descendants(p, NS.w, n).length > 0)
}

function hasVisibleContent(e: HTMLElement): boolean {
  if ((e.textContent ?? '').length > 0) return true
  return e.querySelector('img, .docx-atom, br') !== null
}

// ---------------------------------------------------------------- tabs

/**
 * Sets each tab's width so the text after it starts (or ends, or centres)
 * at the next tab stop (§17.3.1.37): custom stops first, the hanging indent
 * as an implicit stop, then the default stops. The paragraph must be in the
 * document (measured).
 */
export function layoutTabs(p: HTMLElement, para: Paragraph, defaultTabPt: number) {
  const tabs = [...p.querySelectorAll<HTMLElement>('.docx-tab')].filter((t) => t.closest('.docx-p') === p)
  if (tabs.length === 0) return
  const rtl = para.props.bidi === true
  const indentStart = para.props.indent?.startPt ?? 0
  const firstLine = para.props.indent?.firstLinePt ?? 0
  const stops = (para.props.tabs ?? []).filter((t) => t.align !== 'clear' && t.align !== 'bar' && t.align !== 'num')
  const scale = p.getBoundingClientRect().width / (p.offsetWidth || 1) || 1
  const toPt = (px: number) => px / scale / PX_PER_PT
  for (let k = 0; k < tabs.length; k++) {
    const tab = tabs[k]!
    tab.style.width = '0'
    const pr = p.getBoundingClientRect()
    const tr = tab.getBoundingClientRect()
    const x = indentStart + toPt(rtl ? pr.right - tr.right : tr.left - pr.left)
    let stop = stops.find((s) => s.posPt > x + 0.25) ?? null
    if (firstLine < 0 && indentStart > x + 0.25 && (!stop || indentStart < stop.posPt)) stop = { align: 'start', posPt: indentStart, leader: 'none' }
    if (!stop) stop = { align: 'start', posPt: (Math.floor((x + 0.25) / defaultTabPt) + 1) * defaultTabPt, leader: 'none' }
    let width = stop.posPt - x
    if (stop.align === 'end' || stop.align === 'center' || stop.align === 'decimal') {
      const seg = toPt(segmentWidth(tab, tabs[k + 1] ?? null, stop.align === 'decimal', rtl))
      width -= stop.align === 'center' ? seg / 2 : seg
    }
    tab.style.width = `${Math.max(0, width)}pt`
    if (stop.leader !== 'none') {
      const style = stop.leader === 'hyphen' ? 'dashed' : stop.leader === 'underscore' || stop.leader === 'heavy' ? 'solid' : 'dotted'
      tab.style.borderBottom = `${stop.leader === 'heavy' ? 2 : 1.25}px ${style} currentColor`
    }
  }
}

/** The width of the text after `tab` up to the next tab (or, for a decimal tab, up to the first "."). */
function segmentWidth(tab: HTMLElement, next: HTMLElement | null, decimal: boolean, rtl: boolean): number {
  const doc = tab.ownerDocument
  const range = doc.createRange()
  range.setStartAfter(tab)
  const p = tab.closest('.docx-p')!
  if (next) range.setEndBefore(next)
  else range.setEnd(p, p.childNodes.length)
  if (decimal) {
    const walker = doc.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n) || tab.contains(n)) continue
      const i = (n.textContent ?? '').indexOf('.')
      if (i >= 0) {
        range.setEnd(n, i)
        break
      }
    }
  }
  const rects = [...range.getClientRects()]
  if (rects.length === 0) return 0
  // Only the part on the tab's own line.
  const top = tab.getBoundingClientRect().top
  const line = rects.filter((r) => Math.abs(r.top - top) < r.height + 2 || r.top <= top + 1)
  if (line.length === 0) return 0
  void rtl
  return Math.max(...line.map((r) => r.right)) - Math.min(...line.map((r) => r.left))
}

// ---------------------------------------------------------------- tables

export function cellCss(c: TableCell, borders: EdgeBorders): string {
  const m = c.margins
  const css = [
    `border-top:${borderCss(borders.top)}`,
    `border-bottom:${borderCss(borders.bottom)}`,
    `border-inline-start:${borderCss(borders.start)}`,
    `border-inline-end:${borderCss(borders.end)}`,
    `padding-top:${m.topPt ?? 0}pt`,
    `padding-bottom:${m.bottomPt ?? 0}pt`,
    `padding-inline-start:${m.startPt ?? 0}pt`,
    `padding-inline-end:${m.endPt ?? 0}pt`,
    `vertical-align:${c.props.vAlign === 'center' ? 'middle' : (c.props.vAlign ?? 'top')}`,
    'overflow-wrap:break-word',
  ]
  if (c.props.shading) css.push(`background-color:${c.props.shading}`)
  if (c.props.noWrap) css.push('white-space:nowrap')
  if (c.props.textDirection === 'btLr' || c.props.textDirection === 'tbRl' || c.props.textDirection === 'tbRlV') {
    css.push('writing-mode:vertical-rl')
    if (c.props.textDirection === 'btLr') css.push('transform:rotate(180deg)')
  }
  return css.join(';')
}

/** How many rows a vertically merged cell starting in `row` spans, within rows [row, to). */
function rowSpan(t: Table, row: number, gridCol: number, to: number): number {
  let n = 1
  for (let r = row + 1; r < to; r++) {
    const c = t.rows[r]!.cells.find((x) => x.gridCol === gridCol)
    if (c?.props.vMerge === 'continue') n++
    else break
  }
  return n
}

/**
 * A table, or the rows [from, to) of one when it continues on another page
 * (header rows repeat on the continuation, §17.4.49).
 */
export function renderTable(t: Table, env: RenderEnv, from = 0, to = t.rows.length): HTMLElement {
  const table = el(env, 'table', 'docx-table')
  const total = t.grid.reduce((a, b) => a + b, 0)
  const css = ['border-collapse:collapse', 'table-layout:fixed', 'border-spacing:0', 'box-sizing:border-box']
  if (total > 0) css.push(`width:${total}pt`)
  if (t.props.bidiVisual) css.push('direction:rtl')
  if (t.props.align === 'center') css.push('margin-inline:auto')
  else if (t.props.align === 'end') css.push('margin-inline-start:auto')
  else if (t.props.indentPt) css.push(`margin-inline-start:${t.props.indentPt}pt`)
  if (t.props.shading) css.push(`background-color:${t.props.shading}`)
  table.style.cssText = css.join(';')
  if (t.grid.length) {
    const cg = el(env, 'colgroup')
    for (const w of t.grid) {
      const col = el(env, 'col')
      col.style.width = `${w}pt`
      cg.append(col)
    }
    table.append(cg)
  }
  const body = el(env, 'tbody')
  const headers: number[] = []
  if (from > 0) for (let r = 0; r < t.rows.length && t.rows[r]!.props.header; r++) headers.push(r)
  const rowsToRender = [...headers.filter((r) => r < from), ...range(from, to)]
  for (const r of rowsToRender) {
    const row = t.rows[r]!
    const tr = el(env, 'tr')
    tr.dataset.row = String(r)
    if (headers.includes(r) && r < from) tr.dataset.repeated = '1'
    if (row.props.heightPt && row.props.heightRule !== 'auto') tr.style.height = `${row.props.heightPt}pt`
    const gap = (n: number) => {
      const td = el(env, 'td')
      td.colSpan = n
      td.style.border = 'none'
      tr.append(td)
    }
    if (row.props.gridBefore) gap(row.props.gridBefore)
    // Repeated header rows form their own block above the continued rows.
    const blockStart = r < from ? 0 : from
    const rowEnd = r < from ? headers.length : to
    for (const c of row.cells) {
      const continued = c.props.vMerge === 'continue'
      // A continued merge is drawn by the cell above — except on the first row of a block, where it starts again.
      if (continued && r !== blockStart) continue
      const td = el(env, 'td')
      if (c.span > 1) td.colSpan = c.span
      const span = c.props.vMerge ? rowSpan(t, r, c.gridCol, rowEnd) : 1
      if (span > 1) td.rowSpan = span
      // The merged cell's bottom edge is the last merged row's.
      const lastRow = t.rows[r + span - 1]?.cells.find((x) => x.gridCol === c.gridCol)
      td.style.cssText = cellCss(c, { ...c.borders, bottom: lastRow?.borders.bottom ?? c.borders.bottom })
      if (!continued) td.append(renderFlow(c.blocks, env))
      tr.append(td)
    }
    if (row.props.gridAfter) gap(row.props.gridAfter)
    body.append(tr)
  }
  table.append(body)
  return table
}

const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i)

// ---------------------------------------------------------------- blocks

export function renderBlockPlaceholder(b: Extract<Block, { type: 'placeholder' }>, env: RenderEnv): HTMLElement {
  if (b.text) {
    const d = el(env, 'div', 'docx-equation-block')
    d.style.cssText = 'text-align:center;font-style:italic;font-family:"Cambria Math", "STIX Two Math", serif;font-size:11pt;outline:1px dashed #9ca3af;margin:4pt 0'
    d.title = b.label
    d.dataset.testid = 'docx-equation'
    d.textContent = b.text
    return d
  }
  return box(env, { label: b.label, widthPt: null, heightPt: null }, true)
}

export function renderBlock(b: Block, env: RenderEnv, frag: ParagraphFragment = {}): HTMLElement {
  if (b.type === 'paragraph') return renderParagraph(b, env, frag)
  if (b.type === 'table') return renderTable(b, env)
  return renderBlockPlaceholder(b, env)
}

/** Blocks stacked as Word does: a paragraph's space after and the next one's space before add up (flex items don't collapse margins). */
export function renderFlow(blocks: readonly Block[], env: RenderEnv): HTMLElement {
  const flow = el(env, 'div', 'docx-flow')
  flow.style.cssText = 'display:flex;flex-direction:column;align-items:stretch;min-width:0'
  blocks.forEach((b, i) => {
    const e = renderBlock(b, env, { prev: blocks[i - 1] ?? null, next: blocks[i + 1] ?? null })
    if (b.type === 'table') e.style.alignSelf = 'flex-start'
    flow.append(e)
  })
  return flow
}

/** Tab layout for every paragraph inside `root` (a flow element once it is in the document). */
export function layoutAllTabs(root: HTMLElement, defaultTabPt: number) {
  const all = root.matches('.docx-p') ? [root] : []
  all.push(...root.querySelectorAll<HTMLElement>('.docx-p'))
  for (const p of all) {
    const para = PARAGRAPH_OF.get(p)
    if (para && p.querySelector('.docx-tab')) layoutTabs(p, para, defaultTabPt)
  }
}
