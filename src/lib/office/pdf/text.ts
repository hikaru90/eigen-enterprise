import { createRequire } from 'node:module'
import path from 'node:path'
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
    isEvalSupported: false,
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
      page.cleanup()
    }
    return out.join('\n')
  } finally {
    await task.destroy()
  }
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
