/**
 * A web page's readable text for the AI (web.fetch): its title, and the body as plain text with
 * links kept as "label (url)" and block ends as line breaks. Scripts, styles, navigation chrome
 * tags and comments go. Structure only (tags and entities), never a judgement about content.
 */

const ENTITIES: Record<string, string> = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', mdash: '—', ndash: '–', hellip: '…', copy: '©', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export function htmlToReadable(html: string, baseUrl?: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : ''
  const absolute = (href: string) => {
    if (!baseUrl) return href
    try {
      return new URL(href, baseUrl).toString()
    } catch {
      return href
    }
  }
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|template|svg|head|title|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
        const inner = label.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
        if (/^(javascript:|#)/i.test(href)) return inner
        const url = absolute(href)
        return inner && inner !== url ? `${inner} (${url})` : url
      })
      .replace(/<img\b[^>]*?alt\s*=\s*["']([^"']+)["'][^>]*>/gi, ' [image: $1] ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
      .replace(/<\/(p|div|h[1-6]|tr|table|section|article|header|footer|ul|ol|blockquote|pre)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}
