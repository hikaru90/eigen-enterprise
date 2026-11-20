import type { DocxDocument } from '../model'
import type { Numbering } from '../numbering'
import type { SourceRegistry } from './registry'
import { Schema, type DOMOutputSpec, type Mark, type MarkSpec, type Node as PMNode, type NodeSpec } from 'prosemirror-model'
import { fontStack } from '../fonts'
import { alignOfJc, mergeRun, type ParagraphProps, type RunProps } from '../properties'
import { AUTO_SPACING_PT, borderCss, HIGHLIGHT, paragraphCss, runCss, UNDERLINE } from '../render'
import { paragraphRunBase, resolveParagraphProps } from '../styles'

/**
 * The ProseMirror schema for the WordprocessingML the editor knows
 * (plan/phase-office-files.md D2):
 *
 * - blocks: `paragraph` (style, alignment, indents, numbering as attrs;
 *   headings come from the outline level of its style), `table` /
 *   `table_row` / `table_cell` (gridSpan as colspan, vMerge kept),
 *   `section_break` (the w:sectPr a paragraph ends its section with) and
 *   `opaque_block` (content controls, equations, anything else: kept as its
 *   source XML, shown as a readable chip);
 * - inlines: text with marks, `tab`, `hard_break`, `page_break`, `image`
 *   and `opaque` (fields, bookmarks, note references, symbols, tracked
 *   changes, … — source XML kept, shown as a chip or an invisible marker);
 * - marks: `run` (which w:r the text came from — not formatting, it lets an
 *   untouched run keep its exact XML), `link`, and the formatting marks
 *   `charStyle`, `font`, `size`, `color`, `highlight`, `bold`, `italic`,
 *   `underline`, `strike`, `vertAlign` — each one a w:rPr child.
 *
 * Every node and mark from the file has a `ref` into the SourceRegistry.
 * The look follows the document's own styles (styles.xml, numbering) —
 * the continuous "Edit" layout; pagination stays with the Print layout.
 */

export type DisplayContext = {
  doc: DocxDocument
  registry: SourceRegistry
  /** The numbering in use (new lists replace it while editing). */
  numbering(): Numbering
  imageUrl(part: string, contentType: string | null): string | null
}

/** Indents as written on w:ind, in twips (start/end also stand for left/right). */
export type IndentTwips = { start?: number; end?: number; firstLine?: number; hanging?: number }

export type ParagraphAttrs = {
  ref: string | null
  styleId: string | null
  /** ST_Jc as written (left, center, right, both, …). */
  jc: string | null
  ind: IndentTwips | null
  /** Direct w:numPr: numId ("0" switches a style's list off) and level. */
  numId: string | null
  ilvl: number | null
}

export const FORMAT_MARKS = ['charStyle', 'font', 'size', 'color', 'highlight', 'bold', 'italic', 'underline', 'strike', 'vertAlign'] as const
export type FormatMark = (typeof FORMAT_MARKS)[number]

/** The effective numbering of a paragraph: direct numPr, else its style's (numId 0 = none). */
export function effectiveNumbering(ctx: DisplayContext, attrs: ParagraphAttrs): { numId: string; ilvl: number } | null {
  const styled = ctx.doc.styles.paragraphStyle(attrs.styleId ?? undefined).pPr.numbering
  const numId = attrs.numId ?? styled?.numId ?? null
  if (!numId || numId === '0') return null
  return { numId, ilvl: attrs.ilvl ?? styled?.ilvl ?? 0 }
}

const twipsPt = (v: number | undefined) => (v === undefined ? undefined : v / 20)

/** The paragraph's direct properties: the source's (what the editor doesn't change) with the editable ones from its attrs. */
export function directProps(ctx: DisplayContext, attrs: ParagraphAttrs): ParagraphProps {
  const source = ctx.registry.of(attrs.ref, 'paragraph')?.direct ?? {}
  const out: ParagraphProps = { ...source }
  delete out.styleId
  delete out.align
  delete out.indent
  delete out.numbering
  if (attrs.styleId) out.styleId = attrs.styleId
  if (attrs.jc) out.align = alignOfJc(attrs.jc)
  if (attrs.ind) {
    const i = attrs.ind
    const indent: NonNullable<ParagraphProps['indent']> = {}
    if (i.start !== undefined) indent.startPt = i.start / 20
    if (i.end !== undefined) indent.endPt = i.end / 20
    if (i.hanging !== undefined) indent.firstLinePt = -i.hanging / 20
    else if (i.firstLine !== undefined) indent.firstLinePt = twipsPt(i.firstLine)
    out.indent = indent
  }
  if (attrs.numId !== null) out.numbering = attrs.ilvl === null ? { numId: attrs.numId } : { numId: attrs.numId, ilvl: attrs.ilvl }
  return out
}

/** Effective paragraph properties and its runs' base (styles, numbering level, direct). */
export function resolvedParagraph(ctx: DisplayContext, attrs: ParagraphAttrs): { props: ParagraphProps; runBase: RunProps; markRun: RunProps } {
  const styles = ctx.doc.styles
  const direct = directProps(ctx, attrs)
  const num = effectiveNumbering(ctx, attrs)
  const level = num ? ctx.numbering().level(num.numId, num.ilvl) : null
  const props = resolveParagraphProps(styles, direct, [], level?.pPr ?? null)
  const runBase = paragraphRunBase(styles, direct.styleId, [])
  return { props, runBase, markRun: mergeRun(runBase, direct.markRun ?? {}) }
}

/** CSS for the run properties that are set (a layer over inherited ones), not a full run look. */
export function partialRunCss(r: RunProps, ctx: Pick<DisplayContext, 'doc'>): string {
  const css: string[] = []
  const fonts = r.fonts
  if (fonts && (fonts.ascii || fonts.hAnsi || fonts.eastAsia)) css.push(`font-family:${fontStack(fonts.ascii ?? fonts.hAnsi, fonts.eastAsia, ctx.doc.fonts)}`)
  if (r.sizePt !== undefined) css.push(`font-size:${r.sizePt}pt`)
  if (r.bold !== undefined) css.push(`font-weight:${r.bold ? 700 : 400}`)
  if (r.italic !== undefined) css.push(`font-style:${r.italic ? 'italic' : 'normal'}`)
  if (r.caps) css.push('text-transform:uppercase')
  if (r.smallCaps) css.push('font-variant-caps:small-caps')
  if (r.color) css.push(`color:${r.color}`)
  const lines: string[] = []
  if (r.underline && r.underline !== 'none') lines.push('underline')
  if (r.strike || r.doubleStrike) lines.push('line-through')
  if (lines.length) css.push(`text-decoration-line:${lines.join(' ')}`)
  if (r.underline && r.underline !== 'none') css.push(`text-decoration-style:${(UNDERLINE[r.underline] ?? UNDERLINE.single!).style}`)
  const hl = r.highlight && r.highlight !== 'none' ? HIGHLIGHT[r.highlight] : undefined
  if (hl) css.push(`background-color:${hl}`)
  else if (r.shading) css.push(`background-color:${r.shading}`)
  if (r.spacingPt) css.push(`letter-spacing:${r.spacingPt}pt`)
  if (r.positionPt) css.push('position:relative', `top:${-r.positionPt}pt`)
  if (r.vertAlign === 'superscript' || r.vertAlign === 'subscript') css.push(`vertical-align:${r.vertAlign === 'superscript' ? 'super' : 'sub'}`, 'font-size:66%')
  if (r.rtl) css.push('unicode-bidi:embed', 'direction:rtl')
  if (r.border && r.border.style !== 'none') css.push(`border:${borderCss(r.border)}`)
  // Hidden text (w:vanish) stays editable here, marked as hidden.
  if (r.vanish) css.push('opacity:0.55', 'text-decoration-line:underline', 'text-decoration-style:dotted')
  return css.join(';')
}

/** What a run's own w:rPr sets that no formatting mark carries (caps, spacing, borders, …). */
function runSourceCss(r: RunProps, ctx: DisplayContext): string {
  const rest: RunProps = { ...r }
  for (const k of ['bold', 'italic', 'underline', 'strike', 'sizePt', 'color', 'highlight', 'vertAlign'] as const) delete rest[k]
  // Literal fonts are the font mark; theme-only fonts (no ascii/hAnsi written) stay with the run.
  return partialRunCss(rest, ctx)
}

const attr = (dom: HTMLElement, name: string) => dom.getAttribute(name)
const json = <T>(v: string | null): T | null => {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

const SAFE_HREF = /^(https?:|mailto:|tel:)/i

export function createDocxSchema(ctx: DisplayContext): Schema {
  const reg = ctx.registry
  const defaultTabPt = ctx.doc.settings.defaultTabStopPt

  const paragraph: NodeSpec = {
    group: 'block',
    content: 'inline*',
    attrs: { ref: { default: null }, styleId: { default: null }, jc: { default: null }, ind: { default: null }, numId: { default: null }, ilvl: { default: null } },
    parseDOM: [
      {
        tag: 'p',
        getAttrs: (dom) => {
          const d = dom as HTMLElement
          const ilvl = attr(d, 'data-ilvl')
          return {
            ref: attr(d, 'data-ref'),
            styleId: attr(d, 'data-style'),
            jc: attr(d, 'data-jc'),
            ind: json<IndentTwips>(attr(d, 'data-ind')),
            numId: attr(d, 'data-num'),
            ilvl: ilvl === null ? null : Number(ilvl),
          }
        },
      },
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ tag: `h${n}` })),
    ],
    toDOM(node) {
      const a = node.attrs as ParagraphAttrs
      const { props, runBase, markRun } = resolvedParagraph(ctx, a)
      const sp = props.spacing ?? {}
      const before = sp.beforeAuto ? AUTO_SPACING_PT : (sp.beforePt ?? 0)
      const after = sp.afterAuto ? AUTO_SPACING_PT : (sp.afterPt ?? 0)
      const out: Record<string, string> = {
        class: 'docx-p',
        style: `${paragraphCss(props, markRun, ctx, { beforePt: before, afterPt: after, firstLine: true })};${runCss(runBase, ctx)}`,
      }
      if (a.ref) out['data-ref'] = a.ref
      if (a.styleId) out['data-style'] = a.styleId
      if (a.jc) out['data-jc'] = a.jc
      if (a.ind) out['data-ind'] = JSON.stringify(a.ind)
      if (a.numId !== null) out['data-num'] = a.numId
      if (a.ilvl !== null) out['data-ilvl'] = String(a.ilvl)
      if (props.outlineLevel !== undefined && props.outlineLevel >= 0 && props.outlineLevel <= 8) {
        out.role = 'heading'
        out['aria-level'] = String(props.outlineLevel + 1)
      }
      return ['p', out, 0]
    },
  }

  const chip = (kind: 'chip' | 'marker' | 'text', label: string, title: string, ref: string | null, block: boolean): DOMOutputSpec => {
    const attrs: Record<string, string> = { class: block ? 'docx-chip-block' : `docx-${kind}`, 'data-opaque': kind, title, contenteditable: 'false' }
    if (ref) attrs['data-ref'] = ref
    return [block ? 'div' : 'span', attrs, kind === 'marker' ? '' : label]
  }

  const opaqueParse = (tag: string) => ({
    tag: `${tag}[data-opaque]`,
    getAttrs: (dom: HTMLElement | string) => {
      const d = dom as HTMLElement
      const ref = attr(d, 'data-ref')
      // Only this document's own elements can be carried; elsewhere the chip's text is pasted as text.
      if (!reg.of(ref, 'opaque') && !reg.of(ref, 'element')) return false
      return { ref, kind: attr(d, 'data-opaque'), label: d.textContent ?? '', title: attr(d, 'title') ?? '' }
    },
  })

  const nodes: Record<string, NodeSpec> = {
    doc: { content: '(block | section_break)+' },
    paragraph,
    table: {
      group: 'block',
      content: 'table_row+',
      tableRole: 'table',
      isolating: true,
      attrs: { ref: { default: null } },
      parseDOM: [{ tag: 'table', getAttrs: (dom) => ({ ref: attr(dom as HTMLElement, 'data-ref') }) }],
      toDOM(node) {
        const grid = reg.of(node.attrs.ref as string | null, 'table')?.gridTwips ?? []
        const cols = node.firstChild ? Math.max(...mapRows(node, (row) => rowWidth(row))) : 0
        const fits = grid.length > 0 && grid.length === cols
        const attrs: Record<string, string> = { class: 'docx-table', style: `border-collapse:collapse;${fits ? `table-layout:fixed;width:${grid.reduce((a, b) => a + b, 0) / 20}pt` : 'width:100%'}` }
        if (node.attrs.ref) attrs['data-ref'] = node.attrs.ref as string
        const colgroup: DOMOutputSpec = ['colgroup', ...(fits ? grid.map((w) => ['col', { style: `width:${w / 20}pt` }] as DOMOutputSpec) : [])]
        return ['table', attrs, colgroup, ['tbody', 0]]
      },
    },
    table_row: {
      content: 'table_cell+',
      tableRole: 'row',
      attrs: { ref: { default: null } },
      parseDOM: [{ tag: 'tr', getAttrs: (dom) => ({ ref: attr(dom as HTMLElement, 'data-ref') }) }],
      toDOM: (node) => ['tr', node.attrs.ref ? { 'data-ref': node.attrs.ref as string } : {}, 0],
    },
    table_cell: {
      content: 'block+',
      tableRole: 'cell',
      isolating: true,
      attrs: { ref: { default: null }, colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null }, vMerge: { default: null } },
      parseDOM: [
        {
          tag: 'td',
          getAttrs: (dom) => {
            const d = dom as HTMLTableCellElement
            return { ref: attr(d, 'data-ref'), colspan: d.colSpan || 1, rowspan: 1, colwidth: null, vMerge: attr(d, 'data-vmerge') }
          },
        },
        { tag: 'th', getAttrs: (dom) => ({ colspan: (dom as HTMLTableCellElement).colSpan || 1 }) },
      ],
      toDOM(node) {
        const css = reg.of(node.attrs.ref as string | null, 'cell')?.css ?? 'border:0.5pt solid #9ca3af;padding:0 5.4pt;vertical-align:top'
        const attrs: Record<string, string> = { style: css }
        if ((node.attrs.colspan as number) > 1) attrs.colspan = String(node.attrs.colspan)
        if (node.attrs.ref) attrs['data-ref'] = node.attrs.ref as string
        if (node.attrs.vMerge) {
          attrs['data-vmerge'] = node.attrs.vMerge as string
          // A continued vertical merge is part of the cell above: drawn without the edge between them.
          if (node.attrs.vMerge === 'continue') attrs.style = `${css};border-top:none`
        }
        return ['td', attrs, 0]
      },
    },
    section_break: {
      atom: true,
      selectable: true,
      attrs: { ref: { default: null }, label: { default: 'Section break' } },
      parseDOM: [
        {
          tag: 'div[data-section]',
          getAttrs: (dom) => {
            const ref = attr(dom as HTMLElement, 'data-ref')
            return reg.of(ref, 'element') ? { ref, label: (dom as HTMLElement).textContent ?? 'Section break' } : false
          },
        },
      ],
      toDOM: (node) => ['div', { class: 'docx-section-break', 'data-section': '1', 'data-ref': (node.attrs.ref as string | null) ?? '', contenteditable: 'false' }, node.attrs.label as string],
    },
    opaque_block: {
      group: 'block',
      atom: true,
      selectable: true,
      attrs: { ref: { default: null }, kind: { default: 'chip' }, label: { default: '' }, title: { default: '' } },
      parseDOM: [opaqueParse('div')],
      toDOM: (node) => chip(node.attrs.kind as 'chip', node.attrs.label as string, node.attrs.title as string, node.attrs.ref as string | null, true),
    },
    text: { group: 'inline' },
    tab: {
      group: 'inline',
      inline: true,
      attrs: { ref: { default: null } },
      parseDOM: [{ tag: 'span.docx-tab', getAttrs: (dom) => ({ ref: attr(dom as HTMLElement, 'data-ref') }) }],
      toDOM: (node) => ['span', { class: 'docx-tab', 'data-ref': (node.attrs.ref as string | null) ?? '', style: `display:inline-block;min-width:${defaultTabPt}pt`, title: 'Tab' }, '\t'],
      leafText: () => '\t',
    },
    hard_break: {
      group: 'inline',
      inline: true,
      selectable: false,
      attrs: { ref: { default: null } },
      parseDOM: [{ tag: 'br', getAttrs: (dom) => ({ ref: attr(dom as HTMLElement, 'data-ref') }) }],
      toDOM: (node) => ['br', node.attrs.ref ? { 'data-ref': node.attrs.ref as string } : {}],
      leafText: () => '\n',
    },
    page_break: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { ref: { default: null }, kind: { default: 'page' } },
      parseDOM: [
        {
          tag: 'span.docx-page-break',
          getAttrs: (dom) => ({ ref: attr(dom as HTMLElement, 'data-ref'), kind: attr(dom as HTMLElement, 'data-kind') === 'column' ? 'column' : 'page' }),
        },
      ],
      toDOM: (node) => [
        'span',
        { class: 'docx-page-break', 'data-kind': node.attrs.kind as string, 'data-ref': (node.attrs.ref as string | null) ?? '', contenteditable: 'false' },
        node.attrs.kind === 'column' ? 'Column break' : 'Page break',
      ],
    },
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      draggable: true,
      attrs: {
        ref: { default: null },
        part: { default: null },
        contentType: { default: null },
        rId: { default: null },
        widthPt: { default: 0 },
        heightPt: { default: 0 },
        alt: { default: '' },
        name: { default: '' },
        floating: { default: false },
      },
      parseDOM: [
        {
          tag: 'img[data-part]',
          getAttrs: (dom) => {
            const d = dom as HTMLImageElement
            const part = attr(d, 'data-part')
            if (!part || !ctx.doc.pkg.has(part)) return false
            return {
              ref: attr(d, 'data-ref'),
              part,
              contentType: attr(d, 'data-type'),
              rId: attr(d, 'data-rid'),
              widthPt: Number(attr(d, 'data-w') ?? 0),
              heightPt: Number(attr(d, 'data-h') ?? 0),
              alt: d.alt,
              name: attr(d, 'data-name') ?? '',
              floating: attr(d, 'data-floating') === '1',
            }
          },
        },
      ],
      toDOM(node) {
        const a = node.attrs
        const url = a.part ? ctx.imageUrl(a.part as string, a.contentType as string | null) : null
        const size = `${a.widthPt ? `width:${a.widthPt}pt;` : ''}${a.heightPt ? `height:${a.heightPt}pt;` : ''}`
        const data: Record<string, string> = {
          'data-part': (a.part as string | null) ?? '',
          'data-type': (a.contentType as string | null) ?? '',
          'data-rid': (a.rId as string | null) ?? '',
          'data-w': String(a.widthPt),
          'data-h': String(a.heightPt),
          'data-name': a.name as string,
          'data-floating': a.floating ? '1' : '0',
        }
        if (a.ref) data['data-ref'] = a.ref as string
        if (!url) return ['span', { ...data, class: 'docx-chip', 'data-opaque': 'chip', style: size, title: a.alt as string }, a.part ? 'Picture format not shown' : 'Picture missing from the file']
        return ['img', { ...data, class: 'docx-image', src: url, alt: a.alt as string, title: a.floating ? 'Floating picture, shown in line' : (a.alt as string), style: `${size}max-width:100%;object-fit:contain;vertical-align:baseline` }]
      },
    },
    opaque: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { ref: { default: null }, kind: { default: 'chip' }, label: { default: '' }, title: { default: '' }, level: { default: 'para' } },
      parseDOM: [opaqueParse('span')],
      toDOM: (node) => chip(node.attrs.kind as 'chip', node.attrs.label as string, node.attrs.title as string, node.attrs.ref as string | null, false),
      leafText: (node) => (node.attrs.kind === 'marker' ? '' : (node.attrs.label as string)),
    },
  }

  const span = (css: string, data: Record<string, string>): DOMOutputSpec => ['span', { style: css, ...data }, 0]
  const marks: Record<string, MarkSpec> = {
    link: {
      attrs: { href: { default: null }, anchor: { default: null }, tooltip: { default: null }, ref: { default: null } },
      inclusive: false,
      parseDOM: [
        {
          tag: 'a[href], a[data-href], a[data-anchor]',
          getAttrs: (dom) => {
            const d = dom as HTMLAnchorElement
            const anchor = attr(d, 'data-anchor')
            return { href: anchor ? null : (attr(d, 'data-href') ?? attr(d, 'href')), anchor, tooltip: attr(d, 'title'), ref: attr(d, 'data-ref') }
          },
        },
      ],
      toDOM(mark) {
        const a = mark.attrs
        const out: Record<string, string> = { class: 'docx-link', style: 'color:inherit;text-decoration:inherit' }
        if (a.href) {
          out['data-href'] = a.href as string
          if (SAFE_HREF.test((a.href as string).trim())) out.href = (a.href as string).trim()
        }
        if (a.anchor) out['data-anchor'] = a.anchor as string
        if (a.tooltip) out.title = a.tooltip as string
        else if (a.href || a.anchor) out.title = (a.href as string | null) ?? `#${a.anchor as string}`
        if (a.ref) out['data-ref'] = a.ref as string
        return ['a', out, 0]
      },
    },
    run: {
      attrs: { ref: { default: null } },
      parseDOM: [{ tag: 'span[data-run]', getAttrs: (dom) => ({ ref: attr(dom as HTMLElement, 'data-run') }) }],
      toDOM(mark) {
        const entry = reg.of(mark.attrs.ref as string | null, 'run')
        return span(entry ? runSourceCss(entry.direct, ctx) : '', { 'data-run': (mark.attrs.ref as string | null) ?? '' })
      },
    },
    charStyle: {
      attrs: { styleId: {} },
      parseDOM: [{ tag: 'span[data-cstyle]', getAttrs: (dom) => ({ styleId: attr(dom as HTMLElement, 'data-cstyle') }) }],
      toDOM: (mark) => span(partialRunCss(ctx.doc.styles.characterStyle(mark.attrs.styleId as string), ctx), { 'data-cstyle': mark.attrs.styleId as string }),
    },
    font: {
      attrs: { name: {} },
      parseDOM: [{ tag: 'span[data-font]', getAttrs: (dom) => ({ name: attr(dom as HTMLElement, 'data-font') }) }],
      toDOM: (mark) => span(`font-family:${fontStack(mark.attrs.name as string, undefined, ctx.doc.fonts)}`, { 'data-font': mark.attrs.name as string }),
    },
    size: {
      /** Half-points (w:sz). */
      attrs: { halfPoints: {} },
      parseDOM: [{ tag: 'span[data-sz]', getAttrs: (dom) => ({ halfPoints: Number(attr(dom as HTMLElement, 'data-sz')) }) }],
      toDOM: (mark) => span(`font-size:${(mark.attrs.halfPoints as number) / 2}pt`, { 'data-sz': String(mark.attrs.halfPoints) }),
    },
    color: {
      /** RRGGBB, lower case. */
      attrs: { hex: {} },
      parseDOM: [{ tag: 'span[data-color]', getAttrs: (dom) => ({ hex: attr(dom as HTMLElement, 'data-color') }) }],
      toDOM: (mark) => span(`color:#${mark.attrs.hex as string}`, { 'data-color': mark.attrs.hex as string }),
    },
    highlight: {
      /** ST_HighlightColor (yellow, green, …). */
      attrs: { val: {} },
      parseDOM: [{ tag: 'mark[data-hl]', getAttrs: (dom) => ({ val: attr(dom as HTMLElement, 'data-hl') }) }],
      toDOM: (mark) => ['mark', { style: `background-color:${HIGHLIGHT[mark.attrs.val as string] ?? 'transparent'};color:inherit`, 'data-hl': mark.attrs.val as string }, 0],
    },
    bold: {
      parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight=700' }, { style: 'font-weight=bold' }],
      toDOM: () => ['strong', { style: 'font-weight:700' }, 0],
    },
    italic: {
      parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
      toDOM: () => ['em', { style: 'font-style:italic' }, 0],
    },
    underline: {
      /** ST_Underline (single, double, …). */
      attrs: { val: { default: 'single' } },
      parseDOM: [{ tag: 'u', getAttrs: (dom) => ({ val: attr(dom as HTMLElement, 'data-val') ?? 'single' }) }],
      toDOM: (mark) => ['u', { style: `text-decoration-line:underline;text-decoration-style:${(UNDERLINE[mark.attrs.val as string] ?? UNDERLINE.single!).style}`, 'data-val': mark.attrs.val as string }, 0],
    },
    strike: {
      parseDOM: [{ tag: 's' }, { tag: 'strike' }, { tag: 'del' }],
      toDOM: () => ['s', { style: 'text-decoration-line:line-through' }, 0],
    },
    vertAlign: {
      attrs: { val: {} },
      excludes: 'vertAlign',
      parseDOM: [
        { tag: 'sup', getAttrs: () => ({ val: 'superscript' }) },
        { tag: 'sub', getAttrs: () => ({ val: 'subscript' }) },
      ],
      toDOM: (mark) => [mark.attrs.val === 'superscript' ? 'sup' : 'sub', { style: 'font-size:66%' }, 0],
    },
  }

  return new Schema({ nodes, marks })
}

const mapRows = <T>(table: PMNode, fn: (row: PMNode) => T): T[] => {
  const out: T[] = []
  table.forEach((row) => out.push(fn(row)))
  return out
}

/** A row's width in grid columns. */
export const rowWidth = (row: PMNode) => {
  let n = 0
  row.forEach((cell) => (n += (cell.attrs.colspan as number) || 1))
  return n
}

/** The formatting marks of a node (everything but `run` and `link`). */
export const formatMarks = (marks: readonly Mark[]) => marks.filter((m) => (FORMAT_MARKS as readonly string[]).includes(m.type.name))
