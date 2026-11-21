import { createRequire } from 'node:module'
import path from 'node:path'
import type { PdfAnnotation } from './annotate-model'
import { readingParagraphs, type PdfTextItem } from './reading'

/** A PDF that needs a password before anything in it can be read. */
export class PdfPasswordError extends Error {
  constructor() {
    super('This PDF is password-protected, so its text can’t be read.')
    this.name = 'PdfPasswordError'
  }
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let loaded: Promise<PdfJs> | null = null

/**
 * pdf.js in Node (the legacy build, for the server's Node): no worker thread —
 * the worker's handler runs in this thread (`globalThis.pdfjsWorker`).
 */
function pdfjs(): Promise<PdfJs> {
  loaded ??= (async () => {
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
    ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker
    return import('pdfjs-dist/legacy/build/pdf.mjs')
  })()
  return loaded
}

/** pdf.js's data folders (CMaps for CJK text, the standard 14 fonts' metrics), read from disk. */
function dataDir(name: 'cmaps' | 'standard_fonts'): string {
  const pkg = createRequire(import.meta.url).resolve('pdfjs-dist/package.json')
  return path.join(path.dirname(pkg), name) + path.sep
}

/**
 * The PDF's text as Markdown for agents (see ../text.ts): the title from the
 * metadata as `# …`, then `## Page N` per page — `## Page <label> (page N)`
 * when the file labels its pages (/PageLabels, e.g. "iv") — and the page's
 * text in reading order, one paragraph per block (./reading.ts). A page
 * without text (a scan) says so. Encrypted without a password → PdfPasswordError.
 */
export async function extractText(bytes: Uint8Array): Promise<string> {
  const { getDocument, PasswordException } = await pdfjs()
  const task = getDocument({
    // pdf.js takes ownership of the buffer it is given; keep the caller's intact.
    data: bytes.slice(),
    cMapUrl: dataDir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: dataDir('standard_fonts'),
    stopAtErrors: true,
    verbosity: 0,
  })
  let doc
  try {
    doc = await task.promise
  } catch (err) {
    await task.destroy()
    if (err instanceof PasswordException) throw new PdfPasswordError()
    throw err
  }
  try {
    const out: string[] = []
    const annotations = await annotationsOf(bytes)
    const title = await titleOf(doc)
    if (title) out.push(`# ${title}`, '')
    const labels = await doc.getPageLabels()
    for (let n = 1; n <= doc.numPages; n++) {
      const label = labels?.[n - 1]
      out.push(label && label !== String(n) ? `## Page ${label} (page ${n})` : `## Page ${n}`, '')
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const items = content.items.filter(
        (i): i is PdfTextItem & (typeof content.items)[number] => 'str' in i,
      )
      const paragraphs = readingParagraphs(items)
      if (paragraphs.length === 0) out.push('_(no text on this page)_', '')
      for (const p of paragraphs) out.push(p, '')
      out.push(...commentLines(annotations, n - 1))
      page.cleanup()
    }
    return out.join('\n')
  } finally {
    await task.destroy()
  }
}

/** The file's annotations through the same reader the editor uses (./annotate.ts). */
async function annotationsOf(bytes: Uint8Array): Promise<PdfAnnotation[]> {
  const [{ loadForEdit }, { readAnnotations }] = await Promise.all([import('./edit'), import('./annotate')])
  return readAnnotations(await loadForEdit({ bytes: bytes.slice() }))
}

const KIND_LABEL: Record<PdfAnnotation['kind'], string> = {
  Text: 'Note',
  Highlight: 'Highlight',
  Underline: 'Underline',
  StrikeOut: 'Strikethrough',
  Squiggly: 'Squiggly underline',
  FreeText: 'Text box',
  Ink: 'Ink drawing',
  Square: 'Rectangle',
  Circle: 'Ellipse',
  Line: 'Line',
  Other: 'Annotation',
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * What reviewers wrote on one page, as Markdown quotes under its text:
 * `> Note (Ada Owner, completed): text`, replies nested as `>> Reply (…)`.
 * Kinds the editor does not model (links, stamps …) are listed only when
 * they carry words. Top to bottom, as on the page.
 */
function commentLines(all: PdfAnnotation[], page: number): string[] {
  const replies = new Map<string, PdfAnnotation[]>()
  for (const a of all) if (a.inReplyTo) replies.set(a.inReplyTo, [...(replies.get(a.inReplyTo) ?? []), a])
  const top = all
    .filter((a) => a.page === page && !a.inReplyTo && (a.kind !== 'Other' || oneLine(a.contents)))
    .sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0])
  if (top.length === 0) return []
  const lines: string[] = []
  const who = (a: PdfAnnotation) => {
    const parts = [a.author ?? 'unknown author']
    if (a.review && a.review.state !== 'None') parts.push(a.review.state.toLowerCase())
    return parts.join(', ')
  }
  const say = (prefix: string, label: string, a: PdfAnnotation) => {
    const text = oneLine(a.contents)
    lines.push(`${prefix} ${label} (${who(a)})${text ? `: ${text}` : ''}`)
  }
  for (const a of top) {
    say('>', a.kind === 'Other' ? a.subtype : KIND_LABEL[a.kind], a)
    for (const r of replies.get(a.id) ?? []) say('>>', 'Reply', r)
  }
  lines.push('')
  return lines
}

async function titleOf(doc: {
  getMetadata(): Promise<{ info: object; metadata: { get(name: string): unknown } | null }>
}) {
  const { info, metadata } = await doc.getMetadata()
  const xmp = metadata?.get('dc:title')
  const fromInfo = (info as { Title?: unknown }).Title
  const title =
    typeof xmp === 'string' && xmp.trim() ? xmp : typeof fromInfo === 'string' ? fromInfo : ''
  return title.trim()
}
