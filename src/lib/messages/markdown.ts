import type { Config } from 'dompurify'
import DOMPurify from 'isomorphic-dompurify'
import { Marked } from 'marked'

/**
 * Team messages are Markdown written by people: render GFM, then sanitize to a
 * small allowlist. Raw HTML in a message is shown as text, never rendered;
 * links open in a new tab and only http(s)/mailto targets survive.
 */

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const marked = new Marked({ gfm: true, breaks: true })
marked.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },
  },
})

const PURIFY: Config = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: ['href', 'title'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
}

function markLink(node: Element) {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer nofollow')
  }
}

export function renderMessageMarkdown(source: string): string {
  if (!source.trim()) return ''
  const raw = marked.parse(source, { async: false })
  // Scoped hook: added for this call only, so other DOMPurify users are untouched.
  DOMPurify.addHook('afterSanitizeAttributes', markLink)
  try {
    return String(DOMPurify.sanitize(raw, { ...PURIFY, ADD_ATTR: ['target', 'rel'] }))
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes', markLink)
  }
}
