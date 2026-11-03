/**
 * How a Drive file is shown: decided by its file extension and stored MIME
 * type (a format fact, not meaning). Markdown and CSV are the company's
 * editable text formats (W-1) and keep revisions.
 */

export type PreviewKind = 'markdown' | 'csv' | 'image' | 'pdf' | 'text' | 'other'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'])
const TEXT_EXT = new Set(['txt', 'log', 'json', 'yaml', 'yml', 'xml', 'tsv', 'ini', 'toml'])

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
  pdf: 'application/pdf',
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
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf'
  if (IMAGE_EXT.has(ext) || mime.startsWith('image/')) return 'image'
  if (TEXT_EXT.has(ext) || mime.startsWith('text/')) return 'text'
  return 'other'
}

/** Markdown and CSV: text documents that keep a revision on every write. */
export function isRevisioned(name: string): boolean {
  const ext = extensionOf(name)
  return ext === 'md' || ext === 'markdown' || ext === 'csv'
}

/** Files the agent may read as text (drive.read) and write (drive.write_text: revisioned only). */
export function isTextFile(name: string, mime: string): boolean {
  const kind = previewKind(name, mime)
  return kind === 'markdown' || kind === 'csv' || kind === 'text'
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
