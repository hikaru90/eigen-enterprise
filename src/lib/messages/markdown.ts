import type { Config } from 'dompurify'
import DOMPurify from 'isomorphic-dompurify'
import { Marked, type Token, type TokenizerAndRendererExtension, type TokensList } from 'marked'

/**
 * Team messages are Markdown written by people: render GFM, then sanitize to a
 * small allowlist. Raw HTML in a message is shown as text, never rendered;
 * external http(s)/mailto links open in a new tab, while internal
 * `/drive/folder/<id>` and `/drive/file/<id>` links stay in-app.
 * @mentions of people in the company are highlighted (yours more strongly).
 */

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export type MentionOptions = {
  /** Names that can be @mentioned (people's full and first names). */
  names: readonly string[]
  /** The reader's own names: a mention of them is highlighted as "me". */
  me?: readonly string[]
}

type MentionToken = { type: 'mention'; raw: string; name: string; me: boolean }

/** `@Name` where Name is a known person (longest match first), at a word start, ending at a word boundary. */
function mentionExtension(opts: MentionOptions): TokenizerAndRendererExtension {
  const names = [...new Set(opts.names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length)
  const me = new Set((opts.me ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean))
  return {
    name: 'mention',
    level: 'inline',
    start(src: string) {
      const m = /(^|[\s(])@/.exec(src)
      return m ? m.index + m[1].length : undefined
    },
    tokenizer(src: string): MentionToken | undefined {
      if (!src.startsWith('@')) return undefined
      const rest = src.slice(1)
      const lower = rest.toLowerCase()
      for (const name of names) {
        if (!lower.startsWith(name.toLowerCase())) continue
        const after = rest.charAt(name.length)
        if (after && /[\p{L}\p{N}_]/u.test(after)) continue
        const typed = rest.slice(0, name.length)
        return { type: 'mention', raw: `@${typed}`, name: typed, me: me.has(name.toLowerCase()) }
      }
      return undefined
    },
    renderer(token) {
      const t = token as unknown as MentionToken
      return `<span data-mention="${t.me ? 'me' : 'other'}">@${escapeHtml(t.name)}</span>`
    },
  }
}

/**
 * Empty lines the author typed between blocks. Markdown folds any run of
 * blank lines into one paragraph break; a chat message keeps them: each
 * empty line is a `<br>` line between the blocks.
 */
type BlankLinesToken = { type: 'blankLines'; raw: string; count: number }

const blankLines: TokenizerAndRendererExtension = {
  name: 'blankLines',
  level: 'block',
  renderer(token) {
    return `${'<br>'.repeat((token as unknown as BlankLinesToken).count)}\n`
  },
}

/** Top-level `space` tokens between two blocks become their empty lines (a gap of n newlines is n − 1 empty lines). */
function keepBlankLines(tokens: TokensList): TokensList {
  const out = tokens.flatMap((t, i): Token[] => {
    if (t.type !== 'space') return [t]
    const between = i > 0 && tokens.slice(i + 1).some((n) => n.type !== 'space')
    const count = t.raw.split('\n').length - 2
    if (!between || count < 1) return []
    const blank: BlankLinesToken = { type: 'blankLines', raw: t.raw, count }
    return [blank as unknown as Token]
  })
  return Object.assign(out, { links: tokens.links })
}

function makeMarked(mentions?: MentionOptions): Marked {
  const m = new Marked({ gfm: true, breaks: true })
  m.use({
    renderer: {
      html({ text }) {
        return escapeHtml(text)
      },
    },
    extensions: [blankLines],
  })
  if (mentions && mentions.names.length > 0) m.use({ extensions: [mentionExtension(mentions)] })
  return m
}

const plain = makeMarked()
/** One parser per mention set (the page renders many messages with the same people). */
let cached: { key: string; marked: Marked } | null = null

function markedFor(mentions?: MentionOptions): Marked {
  if (!mentions || mentions.names.length === 0) return plain
  const key = JSON.stringify([mentions.names, mentions.me ?? []])
  if (cached?.key !== key) cached = { key, marked: makeMarked(mentions) }
  return cached.marked
}

const DRIVE_LINK_RE = /^\/drive\/(folder|file)\/[A-Za-z0-9_-]+$/

const PURIFY: Config = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span'],
  ALLOWED_ATTR: ['href', 'title', 'data-mention'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?:|mailto:)|\/drive\/(?:folder|file)\/[A-Za-z0-9_-]+$)/i,
}

function markLink(node: Element) {
  if (node.tagName !== 'A' || !node.hasAttribute('href')) return
  const href = node.getAttribute('href') ?? ''
  const drive = DRIVE_LINK_RE.exec(href)
  if (drive) {
    node.setAttribute('data-drive-link', drive[1]!)
    node.removeAttribute('target')
    node.removeAttribute('rel')
    return
  }
  node.removeAttribute('data-drive-link')
  node.setAttribute('target', '_blank')
  node.setAttribute('rel', 'noopener noreferrer nofollow')
}

export function renderMessageMarkdown(source: string, mentions?: MentionOptions): string {
  if (!source.trim()) return ''
  const marked = markedFor(mentions)
  const raw = marked.parser(keepBlankLines(marked.lexer(source)))
  // Scoped hook: added for this call only, so other DOMPurify users are untouched.
  DOMPurify.addHook('afterSanitizeAttributes', markLink)
  try {
    return String(DOMPurify.sanitize(raw, { ...PURIFY, ADD_ATTR: ['target', 'rel'] }))
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes', markLink)
  }
}
