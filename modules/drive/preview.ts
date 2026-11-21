/**
 * How a Drive file is shown: decided by its file extension and stored MIME
 * type (a format fact, not meaning). Markdown and CSV are the company's
 * editable text formats (W-1); they and the office files (PDF, Word,
 * PowerPoint: plan/phase-office-files.md) keep revisions.
 */

import { OFFICE_MIME, type OfficeKind } from '$lib/office/kinds'

export type PreviewKind = 'markdown' | 'csv' | 'html' | 'image' | 'text' | 'other' | OfficeKind

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'])
const TEXT_EXT = new Set(['txt', 'log', 'json', 'yaml', 'yml', 'xml', 'tsv', 'ini', 'toml'])

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  pdf: OFFICE_MIME.pdf,
  docx: OFFICE_MIME.docx,
  pptx: OFFICE_MIME.pptx,
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function previewKind(name: string, mime: string): PreviewKind {
  const ext = extensionOf(name)
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'csv') return 'csv'
  if (ext === 'html' || ext === 'htm' || mime === 'text/html') return 'html'
  const office = officeKind(name, mime)
  if (office) return office
  if (IMAGE_EXT.has(ext) || mime.startsWith('image/')) return 'image'
  if (TEXT_EXT.has(ext) || mime.startsWith('text/')) return 'text'
  return 'other'
}

/** The office format of a file (PDF, Word .docx, PowerPoint .pptx), else null. */
export function officeKind(name: string, mime: string): OfficeKind | null {
  const ext = extensionOf(name)
  if (ext === 'pdf' || mime === OFFICE_MIME.pdf) return 'pdf'
  if (ext === 'docx' || mime === OFFICE_MIME.docx) return 'docx'
  if (ext === 'pptx' || mime === OFFICE_MIME.pptx) return 'pptx'
  return null
}

/** Markdown and CSV: the documents written as text (drive.write_text, the in-place editors). */
export function isTextDocument(name: string): boolean {
  const ext = extensionOf(name)
  return ext === 'md' || ext === 'markdown' || ext === 'csv'
}

/** Files that keep a revision on every write: the text documents and the office files. */
export function isRevisioned(name: string): boolean {
  return isTextDocument(name) || officeKind(name, '') !== null
}

/** Files the agent may read as text (drive.read) and write (drive.write_text: revisioned only). */
export function isTextFile(name: string, mime: string): boolean {
  const kind = previewKind(name, mime)
  return kind === 'markdown' || kind === 'csv' || kind === 'html' || kind === 'text'
}

/**
 * The type a file is served with inside a rendered HTML page (/drive-view):
 * the page itself, its styles, scripts, images, fonts and data, by file
 * extension. Anything else goes out as bytes the browser won't run.
 */
const VIEW_MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wasm: 'application/wasm',
}

export function viewMimeFor(name: string): string {
  return VIEW_MIME_BY_EXT[extensionOf(name)] ?? 'application/octet-stream'
}

/** The MIME type a file is stored and served with: the browser's when given, else from the extension. */
export function mimeFor(name: string, given: string | null | undefined): string {
  const g = given?.trim()
  if (g && g !== 'application/octet-stream') return g
  return MIME_BY_EXT[extensionOf(name)] ?? 'application/octet-stream'
}

/** RFC 4180 CSV → rows of cells (quoted fields, doubled quotes, CRLF/LF, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += c
      continue
    }
    if (c === '"' && cell === '') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** Text previews (Markdown, CSV, HTML source, plain text) and the editor never load more than 2 MB; the original stays downloadable. */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024
