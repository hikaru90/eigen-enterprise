import type { Config } from 'dompurify'
import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'

/**
 * Markdown → sanitized HTML for public website pages. Same stack as the chat
 * renderer (marked + isomorphic-dompurify) but without chat-specific citation
 * token handling. This is presentation only — no meaning extraction.
 */

marked.setOptions({
  gfm: true,
  breaks: true,
})

const PURIFY_OPTIONS: Config = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'strong',
    'em',
    'del',
    's',
    'code',
    'pre',
    'blockquote',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'a',
    'hr',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
  ],
  ALLOWED_ATTR: ['href', 'title', 'align'],
}

/** Parse GitHub-flavored markdown to sanitized HTML for public pages. */
export function renderWebsiteMarkdown(source: string): string {
  const trimmed = source.trim()
  if (!trimmed) return ''
  const raw = marked.parse(trimmed, { async: false })
  if (typeof raw !== 'string') return ''
  return String(DOMPurify.sanitize(raw, PURIFY_OPTIONS))
}
