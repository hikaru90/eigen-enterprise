import type { CommentData } from './comments'
import { parseDocx, type Block, type DocxDocument, type Inline, type Note, type Paragraph, type Table } from './model'
import { symbolChar } from './symbols'

/**
 * The document's text as Markdown for agents and the Brain (`drive.read`,
 * see ../text.ts): headings from outline levels, nested lists, tables as
 * Markdown tables, images as `![alt](image)`, footnotes and endnotes
 * appended. Headers and footers are left out, and hidden text too.
 *
 * Review markup stays readable: tracked insertions as `{+text+}`, deletions
 * as `{-text-}` (with a note at the top that the file has changes nobody
 * accepted yet), and comments appended as `> Comment (author): text`,
 * replies indented under them. Runs in Node and the browser.
 */
export async function extractText(bytes: Uint8Array): Promise<string> {
  return toMarkdown(parseDocx(bytes))
}

type Line = { text: string; list: boolean }

export const CHANGES_NOTE =
  '> Note: this document has tracked changes that are not accepted yet. Inserted text is shown as {+text+}, deleted text as {-text-}.'

export function toMarkdown(doc: DocxDocument): string {
  const out: Line[] = []
  if (hasTextChanges(doc)) out.push({ text: CHANGES_NOTE, list: false })
  for (const s of doc.sections) blocks(s.blocks, out)
  const notes = (list: Note[], prefix: string) =>
    list.map((n) => ({ text: `[^${prefix}${n.mark || n.id}]: ${noteText(n)}`, list: true }))
  const appended = [...notes(doc.footnotes, ''), ...notes(doc.endnotes, 'e')]
  if (appended.length) {
    out.push({ text: '', list: false })
    out.push(...appended)
  }
  const comments = commentLines(doc.comments)
  if (comments.length) {
    out.push({ text: '', list: false })
    out.push(...comments.map((text) => ({ text, list: true })))
  }
  return join(out)
}

/** Threads in file order: each top-level comment, then its replies (one level deeper per reply). */
function commentLines(list: readonly CommentData[]): string[] {
  const ids = new Set(list.map((c) => c.id))
  const repliesOf = new Map<string, CommentData[]>()
  for (const c of list) if (c.parentId && ids.has(c.parentId)) repliesOf.set(c.parentId, [...(repliesOf.get(c.parentId) ?? []), c])
  const out: string[] = []
  const add = (c: CommentData, depth: number) => {
    const who = `${c.author || 'Unknown author'}${c.done ? ', resolved' : ''}`
    out.push(`${'>'.repeat(depth + 1)} ${depth === 0 ? 'Comment' : 'Reply'} (${who}): ${c.text.replace(/\s*\n\s*/g, ' ').trim()}`)
    for (const r of repliesOf.get(c.id) ?? []) add(r, depth + 1)
  }
  for (const c of list) if (!c.parentId || !ids.has(c.parentId)) add(c, 0)
  return out
}

/** Whether the body has inserted or deleted text not yet accepted (format-only changes don't change the text). */
function hasTextChanges(doc: DocxDocument): boolean {
  const inInlines = (list: readonly Inline[]): boolean =>
    list.some((i) => i.type === 'change' || ((i.type === 'link' || i.type === 'field') && inInlines(i.children)))
  const inBlocks = (list: readonly Block[]): boolean =>
    list.some((b) => (b.type === 'paragraph' ? inInlines(b.inlines) : b.type === 'table' ? b.rows.some((r) => r.cells.some((c) => inBlocks(c.blocks))) : false))
  return doc.sections.some((s) => inBlocks(s.blocks))
}

/** Blank lines between blocks; list items (and notes) stay on consecutive lines. */
function join(lines: Line[]): string {
  let md = ''
  let prev: Line | null = null
  let gap = false
  for (const l of lines) {
    if (l.text === '' && !l.list) {
      gap = true
      continue
    }
    if (md) md += prev?.list && l.list && !gap ? '\n' : '\n\n'
    md += l.text
    prev = l
    gap = false
  }
  return md ? `${md}\n` : ''
}

type ListFrame = { ilvl: number; contentIndent: number }

function blocks(list: readonly Block[], out: Line[]) {
  let stack: ListFrame[] = []
  for (const b of list) {
    if (b.type === 'table') {
      stack = []
      out.push({ text: table(b), list: false })
      continue
    }
    if (b.type === 'placeholder') {
      stack = []
      out.push({ text: b.text || `[${b.label}]`, list: false })
      continue
    }
    const para = paragraph(b, stack)
    if (para === null) continue
    if (!b.list || b.props.outlineLevel !== undefined) stack = []
    out.push(para)
  }
}

function paragraph(p: Paragraph, stack: ListFrame[]): Line | null {
  const text = inline(p.inlines).trim()
  const lvl = p.props.outlineLevel
  const listText = p.list ? listLabel(p) : null
  if (lvl !== undefined && lvl >= 0 && lvl <= 8) {
    if (!text) return null
    return { text: `${'#'.repeat(Math.min(lvl + 1, 6))} ${listText && listText.label ? `${listText.label} ` : ''}${text}`, list: false }
  }
  if (p.list && listText) {
    while (stack.length && stack.at(-1)!.ilvl >= p.list.ilvl) stack.pop()
    const indent = stack.at(-1)?.contentIndent ?? 0
    const marker = listText.marker
    stack.push({ ilvl: p.list.ilvl, contentIndent: indent + marker.length })
    return { text: `${' '.repeat(indent)}${marker}${text}`, list: true }
  }
  if (!text) return null
  return { text: escapeStart(text), list: false }
}

/** Bullets as "- ", decimal numbering as "n. ", any other label kept after "- ". */
function listLabel(p: Paragraph): { marker: string; label: string } {
  const l = p.list!
  const fmt = l.level.format
  if (fmt === 'bullet' || fmt === 'none') return { marker: '- ', label: '' }
  if ((fmt === 'decimal' || fmt === 'decimalZero') && /^%\d[.)]?$/.test(l.level.text.trim())) return { marker: `${l.value}. `, label: l.text }
  return { marker: `- ${l.text} `, label: l.text }
}

/** Text Markdown would read as a heading, quote or list at the start of a paragraph. */
function escapeStart(text: string): string {
  return text.replace(/^(#|>|[-+*] )/, '\\$1').replace(/^(\d+)([.)] )/, '$1\\$2')
}

function inline(list: readonly Inline[]): string {
  let s = ''
  for (const i of list) {
    switch (i.type) {
      case 'text':
        if (!i.run.vanish) s += i.text
        break
      case 'tab':
        s += '\t'
        break
      case 'break':
        if (i.kind === 'line') s += '  \n'
        break
      case 'symbol':
        s += symbolChar(i.font, i.code).char
        break
      case 'image':
        s += `![${i.alt.replace(/[[\]]/g, '')}](image)`
        break
      case 'link': {
        const text = inline(i.children)
        s += i.href && text.trim() ? `[${text}](${i.href})` : text
        break
      }
      case 'field': {
        const text = inline(i.children)
        const href = i.code === 'HYPERLINK' && !i.switches.l ? i.args[0] : undefined
        s += href && text.trim() ? `[${text}](${href})` : text
        break
      }
      case 'change': {
        const text = inline(i.children)
        if (text) s += i.kind === 'insert' ? `{+${text}+}` : `{-${text}-}`
        break
      }
      case 'ruby':
        s += inline(i.base)
        break
      case 'noteRef':
        s += `[^${i.kind === 'endnote' ? 'e' : ''}${i.mark || i.id}]`
        break
      case 'placeholder':
        if (i.blocks.length) s += i.blocks.map(blockText).join(' ')
        else if (i.what === 'equation') s += i.text
        else if (i.label) s += `[${i.label}]`
        break
      case 'noteMark':
      case 'bookmark':
        break
    }
  }
  return s
}

/** A block flattened to one line (table cells, text boxes, notes). */
function blockText(b: Block): string {
  if (b.type === 'paragraph') return inline(b.inlines).replace(/\s*\n\s*/g, ' ').trim()
  if (b.type === 'table') return b.rows.map((r) => r.cells.map((c) => c.blocks.map(blockText).join(' ')).join(' | ')).join(' / ')
  return b.text || `[${b.label}]`
}

function noteText(n: Note): string {
  return n.blocks
    .map(blockText)
    .filter(Boolean)
    .join(' ')
    .trim()
}

function table(t: Table): string {
  const width = Math.max(t.grid.length, ...t.rows.map((r) => (r.props.gridBefore ?? 0) + r.cells.reduce((n, c) => n + c.span, 0) + (r.props.gridAfter ?? 0)))
  const rows = t.rows.map((r) => {
    const cells: string[] = Array<string>(r.props.gridBefore ?? 0).fill('')
    for (const c of r.cells) {
      const text = c.props.vMerge === 'continue' ? '' : c.blocks.map(blockText).filter(Boolean).join('<br>')
      cells.push(text.replace(/\|/g, '\\|'))
      for (let k = 1; k < c.span; k++) cells.push('')
    }
    while (cells.length < width) cells.push('')
    return `| ${cells.join(' | ')} |`
  })
  if (rows.length === 0) return ''
  rows.splice(1, 0, `| ${Array<string>(width).fill('---').join(' | ')} |`)
  return rows.join('\n')
}
