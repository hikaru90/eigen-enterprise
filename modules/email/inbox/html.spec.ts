import { describe, expect, it } from 'vitest'
import { mailDocument, sanitizeMailHtml } from './html'

/** HTML mail is untrusted: sanitized on the server, shown in a sandboxed iframe whose CSP blocks remote loads. */

const ORIGIN = 'https://os.example.com'
const opts = { origin: ORIGIN, images: false, inline: new Map<string, string>() }

describe('sanitizeMailHtml', () => {
  it('drops scripts, event handlers, forms, base, meta refresh, frames and javascript: links', () => {
    const { html } = sanitizeMailHtml(
      [
        '<base href="https://evil.example/">',
        '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        '<script>alert(1)</script>',
        '<p onclick="alert(2)" onmouseover="x()">Hello</p>',
        '<form action="https://evil.example/steal"><input name="pw"><button>Go</button></form>',
        '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="y">',
        '<a href="javascript:alert(3)">bad</a>',
        '<link rel="stylesheet" href="https://evil.example/a.css">',
      ].join(''),
      opts,
    )
    expect(html).toContain('<p>Hello</p>')
    for (const gone of ['<script', 'onclick', 'onmouseover', '<form', '<input', '<button', '<base', '<meta', '<iframe', '<object', '<embed', 'javascript:', '<link', 'refresh']) {
      expect(html).not.toContain(gone)
    }
  })

  it('opens every link in a new tab without opener or referrer', () => {
    const { html } = sanitizeMailHtml('<a href="https://ok.example/x" target="_self">ok</a>', opts)
    expect(html).toContain('href="https://ok.example/x"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('keeps the mail’s own styles and data: images', () => {
    const { html, remoteImages } = sanitizeMailHtml(
      '<style>p{color:red}</style><p style="font-weight:bold">x</p><img src="data:image/gif;base64,R0lGODlh" alt="logo">',
      opts,
    )
    expect(html).toContain('<style>p{color:red}</style>')
    expect(html).toContain('style="font-weight:bold"')
    expect(html).toContain('src="data:image/gif;base64,R0lGODlh"')
    expect(remoteImages).toBe(false)
  })

  it('reports remote images (src and srcset) so the reader can offer “Show images”', () => {
    expect(sanitizeMailHtml('<img src="https://track.example/p.gif">', opts).remoteImages).toBe(true)
    expect(sanitizeMailHtml('<img srcset="http://cdn.example/a.png 2x">', opts).remoteImages).toBe(true)
    expect(sanitizeMailHtml('<p>no images</p>', opts).remoteImages).toBe(false)
  })

  it('leaves remote image URLs out of the HTML until the reader asks for images', () => {
    const mail = '<img src="https://track.example/p.gif" alt="p"><img srcset="https://cdn.example/a.png 2x">'
    const blocked = sanitizeMailHtml(mail, opts).html
    expect(blocked).not.toContain('track.example')
    expect(blocked).not.toContain('cdn.example')
    expect(blocked).toContain('alt="p"')
    const shown = sanitizeMailHtml(mail, { ...opts, images: true })
    expect(shown.html).toContain('src="https://track.example/p.gif"')
    expect(shown.html).toContain('srcset="https://cdn.example/a.png 2x"')
    expect(shown.remoteImages).toBe(true)
  })

  it('points cid: images at the attachment route, and drops cid: references nobody can resolve', () => {
    const inline = new Map([['logo@sender.example', 'att-1']])
    const { html } = sanitizeMailHtml('<img src="cid:logo@sender.example"><img src="cid:missing@x">', { ...opts, inline })
    expect(html).toContain(`src="${ORIGIN}/m/email/inbox/attachments/att-1?inline=1"`)
    expect(html).not.toContain('cid:')
  })

  it('leaves the shared DOMPurify instance without its hooks afterwards', async () => {
    sanitizeMailHtml('<a href="https://x.example">x</a>', opts)
    const DOMPurify = (await import('isomorphic-dompurify')).default
    expect(DOMPurify.sanitize('<a href="https://x.example">x</a>')).toBe('<a href="https://x.example">x</a>')
  })
})

describe('mailDocument (the iframe srcdoc)', () => {
  it('blocks every remote load by default: only inline styles, data: images and the attachment route', () => {
    const doc = mailDocument('<p>x</p>', opts)
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(doc)?.[1]
    expect(csp).toBe(`default-src 'none'; style-src 'unsafe-inline'; img-src data: ${ORIGIN}/m/email/inbox/attachments/`)
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<p>x</p>'))
  })

  it('allows https images only when the reader asked to show them', () => {
    const doc = mailDocument('<p>x</p>', { ...opts, images: true })
    expect(doc).toContain(`img-src data: ${ORIGIN}/m/email/inbox/attachments/ https:;`.replace(/;$/, ''))
  })
})
