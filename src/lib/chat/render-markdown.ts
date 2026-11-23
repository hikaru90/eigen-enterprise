import type { Config } from 'dompurify'
import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'
import { citationDisplayLabel, replaceCitationTokens } from './citation-tokens'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Turn raw citation tokens into compact inline citation chips for chat display. */
export function formatCitationTokens(source: string): string {
  return replaceCitationTokens(source, (id) => {
    const safeId = escapeHtml(id)
    const label = escapeHtml(citationDisplayLabel(id))
    return `<span class="chat-citation" title="Source ${safeId}">${label}</span>`
  })
}

marked.setOptions({
  gfm: true,
  breaks: true,
})

/**
 * Where a chat link goes (board de821eda): a path in this app — or this app's
 * own full address, when its origin is known — opens in the same tab as an
 * in-app path, so SvelteKit navigates client-side and the shell (the open
 * assistant panel, the voice reading a reply) stays. Any other address opens
 * in a new tab. URL structure only, never the link's words.
 */
function inAppPath(href: string, origin: string | undefined): string | null {
  if (href.startsWith('/') && !href.startsWith('//')) return href
  if (!origin) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null // neither a path nor an absolute address: not an in-app link
  }
  if (url.origin !== new URL(origin).origin) return null
  return `${url.pathname}${url.search}${url.hash}`
}

function chatRenderer(origin: string | undefined) {
  const renderer = new marked.Renderer()
  renderer.link = ({ href, title, text }) => {
    const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : ''
    const path = inAppPath(href ?? '', origin)
    if (path !== null) return `<a href="${path}"${titleAttr}>${text}</a>`
    return `<a href="${href ?? ''}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
  }
  return renderer
}

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
    'span',
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'align', 'class'],
}

export type RenderMarkdownOptions = {
  /** This app's origin (page.url.origin): its full addresses then open in the same tab too. */
  origin?: string
}

/** Parse GitHub-flavored markdown to sanitized HTML for chat display. */
export function renderMarkdownToHtml(source: string, options: RenderMarkdownOptions = {}): string {
  const trimmed = source.trim()
  if (!trimmed) return ''
  const raw = marked.parse(formatCitationTokens(trimmed), {
    async: false,
    renderer: chatRenderer(options.origin),
  })
  if (typeof raw !== 'string') return ''
  return String(DOMPurify.sanitize(raw, PURIFY_OPTIONS))
}
