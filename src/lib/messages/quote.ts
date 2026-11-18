/**
 * Quoted replies (Contribute 2a58bcc8, WhatsApp-style "Reply"): what a quote
 * shows of the original — its first line and a marker for its files. Shared
 * by the messages service (the stored quote in every DTO) and the composer's
 * preview, so both read the same.
 */

export const QUOTE_SNIPPET_MAX = 120

/** The first non-empty line of the original's Markdown source, cut to QUOTE_SNIPPET_MAX. */
export function quoteSnippet(body: string): string {
  const line = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length <= QUOTE_SNIPPET_MAX ? line : `${line.slice(0, QUOTE_SNIPPET_MAX - 1)}…`
}

export type QuoteAttachment = { kind: 'voice' | 'image' | 'file'; label: string; count: number }

/** The quote's file marker, decided by the first file's media type (audio = a voice message). */
export function attachmentMarker(files: ReadonlyArray<{ name: string; mime: string }>): QuoteAttachment | null {
  const first = files[0]
  if (!first) return null
  const top = first.mime.split('/')[0]?.toLowerCase()
  if (top === 'audio') return { kind: 'voice', label: 'Voice message', count: files.length }
  if (top === 'image') return { kind: 'image', label: 'Photo', count: files.length }
  return { kind: 'file', label: first.name, count: files.length }
}

/** A quoted original as every client gets it (null fields once the original is deleted). */
export type ReplyQuote = {
  id: string
  /** The original's thread parent (a quote of a thread reply opens that thread). */
  parentId: string | null
  deleted: boolean
  authorId: string | null
  authorName: string | null
  snippet: string
  attachment: QuoteAttachment | null
  /** The original is a call line. */
  call: boolean
}
