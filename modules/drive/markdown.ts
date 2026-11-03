import DOMPurify from 'isomorphic-dompurify'
import { Marked } from 'marked'

/**
 * Markdown → sanitized HTML for the Drive preview (presentation only). GFM
 * (tables, task lists); DOMPurify strips scripts, event handlers, iframes,
 * forms and javascript: URLs, so a shared file can never run code in the
 * viewer's session.
 */
const md = new Marked({ gfm: true, breaks: false, async: false })

export function renderDriveMarkdown(source: string): string {
  const html = md.parse(source) as string
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style'],
  })
}
