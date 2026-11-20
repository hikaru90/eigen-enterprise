import { openDeck, type Paragraph, type ShapeNode, type Slide, type Table, type TextBody } from './model'

/**
 * The deck's text as Markdown for agents and the Brain (see ../text.ts):
 * one `## Slide N: <title>` section per slide (the title or centre-title
 * placeholder), the other text as lists nested by paragraph level, tables as
 * Markdown tables, picture descriptions, a note for what has no readable text
 * yet (charts, SmartArt), and `> Notes:` with the speaker notes. Runs in Node
 * and the browser; a broken file throws (OpcError/PptxError) with the reason.
 */
export async function extractText(bytes: Uint8Array): Promise<string> {
  const { deck } = openDeck(bytes)
  return deck.slides.map(slideMarkdown).join('\n')
}

/** Placeholder types that are slide furniture (date, slide number), left out. */
const FURNITURE = new Set(['dt', 'sldNum'])

function paragraphText(p: Paragraph, slide: Slide): string {
  return p.runs
    .map((r) => (r.kind === 'break' ? ' ' : r.kind === 'field' && r.type === 'slidenum' ? String(slide.number) : r.text))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function bodyText(body: TextBody | null, slide: Slide): string {
  return (body?.paragraphs ?? []).map((p) => paragraphText(p, slide)).filter(Boolean).join(' ')
}

const isTitle = (s: ShapeNode) => s.ph?.type === 'title' || s.ph?.type === 'ctrTitle'

function list(body: TextBody, slide: Slide): string | null {
  const lines = body.paragraphs.flatMap((p) => {
    const t = paragraphText(p, slide)
    return t ? [`${'  '.repeat(p.props.lvl ?? 0)}- ${t}`] : []
  })
  return lines.length ? lines.join('\n') : null
}

const cellText = (s: string) => s.replace(/\|/g, '\\|')

function table(t: Table, slide: Slide): string {
  const rows = t.rows.map((r) => r.cells.map((c) => (c.hMerge || c.vMerge ? '' : cellText(bodyText(c.text, slide)))))
  const width = Math.max(1, ...rows.map((r) => r.length))
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
  const [head = [], ...rest] = rows
  return [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rest.map(line)].join('\n')
}

function blocks(shapes: ShapeNode[], slide: Slide, out: string[]) {
  for (const s of shapes) {
    if (isTitle(s) || (s.ph && FURNITURE.has(s.ph.type))) continue
    switch (s.kind) {
      case 'sp': {
        const l = s.text ? list(s.text, slide) : null
        if (l) out.push(l)
        break
      }
      case 'group':
        blocks(s.children, slide, out)
        break
      case 'pic':
        if (s.descr) out.push(`_(${s.media === 'video' ? 'Video' : s.media === 'audio' ? 'Audio' : 'Picture'}: ${s.descr.replace(/\s+/g, ' ').trim()})_`)
        break
      case 'frame': {
        const c = s.content
        if (c.kind === 'table') out.push(table(c.table, slide))
        else if (c.kind === 'chart') out.push('_(Chart — not readable yet)_')
        else if (c.kind === 'diagram') out.push('_(SmartArt graphic — not readable yet)_')
        else if (c.kind === 'ole') out.push(`_(Embedded object${c.progId ? ` ${c.progId}` : ''} — not readable yet)_`)
        break
      }
      case 'other':
        break
    }
  }
}

function findTitle(shapes: ShapeNode[]): ShapeNode | null {
  for (const s of shapes) {
    if (isTitle(s)) return s
    if (s.kind === 'group') {
      const t = findTitle(s.children)
      if (t) return t
    }
  }
  return null
}

function slideMarkdown(slide: Slide): string {
  const titleShape = findTitle(slide.shapes)
  const title = titleShape?.kind === 'sp' ? bodyText(titleShape.text, slide) : ''
  const head = `## Slide ${slide.number}${slide.hidden ? ' (hidden)' : ''}${title ? `: ${title}` : ''}`
  const out: string[] = [head]
  blocks(slide.shapes, slide, out)
  const notes = (slide.notes?.paragraphs ?? []).map((p) => paragraphText(p, slide)).filter(Boolean)
  if (notes.length) out.push([`> Notes: ${notes[0]}`, ...notes.slice(1).map((n) => `> ${n}`)].join('\n'))
  return `${out.join('\n\n')}\n`
}
