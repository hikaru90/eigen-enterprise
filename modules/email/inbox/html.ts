import DOMPurify from 'isomorphic-dompurify'

/**
 * Received HTML mail is stored as it arrived and made safe when shown (plan
 * §1, §4). Two layers: DOMPurify on the server (no scripts, forms, event
 * handlers, <base>, <meta>, frames, plugin objects), then a sandboxed iframe
 * (no allow-scripts, no allow-same-origin) whose own CSP lets nothing load but
 * inline styles, data: images and our attachment route — https images only
 * after the reader clicks "Show images".
 */

export const ATTACHMENT_PATH = '/m/email/inbox/attachments/'

export type MailHtmlOptions = {
  /** This console's origin, e.g. https://os.example.com (the iframe has an opaque origin, so 'self' can't name it). */
  origin: string
  /** The reader asked to show remote images for this mail. */
  images: boolean
  /** Content-ID (no angle brackets) → attachment id, for cid: images. */
  inline: Map<string, string>
}

const FORBID_TAGS = [
  'script',
  'noscript',
  'template',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'base',
  'meta',
  'link',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
]
const FORBID_ATTR = ['action', 'formaction', 'ping', 'http-equiv']

function isRemote(url: string): boolean {
  try {
    const { protocol } = new URL(url.trim())
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** The URLs in a srcset value (`url [descriptor], url [descriptor]`). */
function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean)
}

export function attachmentUrl(origin: string, attachmentId: string, inline: boolean): string {
  return `${origin}${ATTACHMENT_PATH}${encodeURIComponent(attachmentId)}${inline ? '?inline=1' : ''}`
}

export function sanitizeMailHtml(html: string, opts: MailHtmlOptions): { html: string; remoteImages: boolean } {
  let remoteImages = false
  const hook = (node: Element) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src')
      if (src && src.trim().toLowerCase().startsWith('cid:')) {
        const id = opts.inline.get(decodeURIComponent(src.trim().slice(4)))
        if (id) node.setAttribute('src', attachmentUrl(opts.origin, id, true))
        else node.removeAttribute('src')
      } else if (src && isRemote(src)) {
        remoteImages = true
        // Blocked twice: not even in the srcdoc (the browser must never see the URL), and by the CSP.
        if (!opts.images) node.removeAttribute('src')
      }
      const srcset = node.getAttribute('srcset')
      if (srcset && srcsetUrls(srcset).some(isRemote)) {
        remoteImages = true
        if (!opts.images) node.removeAttribute('srcset')
      }
    }
  }
  DOMPurify.addHook('afterSanitizeAttributes', hook)
  try {
    const clean = DOMPurify.sanitize(html, {
      FORBID_TAGS,
      FORBID_ATTR,
      ALLOW_DATA_ATTR: false,
      // Keep a leading <style> block (mail puts its CSS first).
      FORCE_BODY: true,
      ADD_TAGS: ['style'],
      // DOMPurify's default URI rule keeps cid: (rewritten in the hook) and data: on images only.
    })
    return { html: clean, remoteImages }
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes', hook)
  }
}

export function mailCsp(opts: Pick<MailHtmlOptions, 'origin' | 'images'>): string {
  const img = ['data:', `${opts.origin}${ATTACHMENT_PATH}`, ...(opts.images ? ['https:'] : [])].join(' ')
  return `default-src 'none'; style-src 'unsafe-inline'; img-src ${img}`
}

const BASE_STYLE =
  'html{color-scheme:light}body{margin:0;padding:16px;background:#fff;color:#111;font:14px/1.5 system-ui,-apple-system,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}'

/** The iframe's srcdoc: the CSP first, then a neutral base style, then the sanitized mail. */
export function mailDocument(sanitizedHtml: string, opts: Pick<MailHtmlOptions, 'origin' | 'images'>): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${mailCsp(opts)}">`,
    `<style>${BASE_STYLE}</style></head><body>`,
    sanitizedHtml,
    '</body></html>',
  ].join('')
}
