import type { Block, BlockPlaceholder, DocxSettings, Inline, Paragraph, Section, Table } from './model'
import { formatNumber } from './numbering'

/**
 * The pure part of pagination: a section's blocks as flow items (paragraphs
 * cut at their page breaks), page numbers in a section's format, and which
 * header/footer a page uses. The measuring part is ./paginate.ts.
 */

export type FlowItem =
  | {
      kind: 'paragraph'
      para: Paragraph
      inlines: Inline[]
      /** First piece of the paragraph (list label, first-line indent, space before). */
      first: boolean
      /** Last piece (space after). */
      last: boolean
      /** Starts a new page: a page break before it, or w:pageBreakBefore. */
      breakBefore: boolean
      keepNext: boolean
      prev: Block | null
      next: Block | null
    }
  | { kind: 'table'; table: Table; breakBefore: boolean; keepNext: boolean }
  | { kind: 'placeholder'; block: BlockPlaceholder; breakBefore: boolean; keepNext: boolean }

const CONTAINERS = new Set(['link', 'field', 'change'])

/** Cuts inlines at page breaks (w:br w:type="page"), splitting links/fields/changes that contain one. */
export function splitAtPageBreaks(inlines: readonly Inline[]): Inline[][] {
  const pieces: Inline[][] = [[]]
  for (const i of inlines) {
    if (i.type === 'break' && i.kind === 'page') {
      pieces.push([])
      continue
    }
    if (CONTAINERS.has(i.type) && 'children' in i) {
      const parts = splitAtPageBreaks(i.children)
      parts.forEach((children, k) => {
        if (k > 0) pieces.push([])
        if (children.length) pieces.at(-1)!.push({ ...i, children } as Inline)
      })
      continue
    }
    pieces.at(-1)!.push(i)
  }
  return pieces
}

const visible = (list: readonly Inline[]) => list.some((i) => i.type !== 'bookmark')

export function flowItems(blocks: readonly Block[]): FlowItem[] {
  const out: FlowItem[] = []
  let breakNext = false
  blocks.forEach((b, idx) => {
    const prev = blocks[idx - 1] ?? null
    const next = blocks[idx + 1] ?? null
    if (b.type === 'table') {
      out.push({ kind: 'table', table: b, breakBefore: breakNext, keepNext: false })
      breakNext = false
      return
    }
    if (b.type === 'placeholder') {
      out.push({ kind: 'placeholder', block: b, breakBefore: breakNext, keepNext: false })
      breakNext = false
      return
    }
    const pieces = splitAtPageBreaks(b.inlines)
    pieces.forEach((inlines, k) => {
      const first = k === 0
      const last = k === pieces.length - 1
      // A piece with nothing in it before a page break (a paragraph that starts with the break) takes no room.
      if (!last && !visible(inlines) && !(first && b.list)) {
        breakNext = true
        return
      }
      out.push({
        kind: 'paragraph',
        para: b,
        inlines,
        first,
        last,
        breakBefore: breakNext || (first && b.props.pageBreakBefore === true),
        keepNext: last && b.props.keepNext === true,
        prev,
        next,
      })
      breakNext = !last
    })
  })
  return out
}

/** A page number in the section's w:pgNumType format. */
export function formatPageNumber(n: number, format: string | undefined): string {
  if (format === 'numberInDash') return `- ${n} -`
  return formatNumber(n, format ?? 'decimal').text
}

/**
 * The header and footer parts a page shows (§17.10): the first-page ones on
 * a section's first page when w:titlePg is set, even ones on even pages when
 * the document has w:evenAndOddHeaders, else the defaults. A type the
 * section (and the sections before it) never defines shows nothing.
 */
export function headerFooterFor(
  section: Section,
  pageInSection: number,
  pageNumber: number,
  settings: DocxSettings,
): { header: string | null; footer: string | null } {
  const kind = section.props.titlePage && pageInSection === 0 ? 'first' : settings.evenAndOddHeaders && pageNumber % 2 === 0 ? 'even' : 'default'
  return { header: section.props.headers[kind] ?? null, footer: section.props.footers[kind] ?? null }
}
