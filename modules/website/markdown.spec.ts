import { describe, expect, it } from 'vitest'
import { renderWebsiteMarkdown } from './markdown'

describe('renderWebsiteMarkdown', () => {
  it('renders headings, paragraphs, emphasis, lists, and links', () => {
    const html = renderWebsiteMarkdown(
      '# Title\n\nA paragraph with **bold** and _em_.\n\n- one\n- two\n\n[site](https://example.com)',
    )

    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>em</em>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<li>two</li>')
    expect(html).toContain('<a href="https://example.com"')
  })

  it('renders an empty string to empty output', () => {
    expect(renderWebsiteMarkdown('')).toBe('')
    expect(renderWebsiteMarkdown('   \n  ')).toBe('')
  })

  it('sanitizes scripts, event handlers, and dangerous tags out of the body', () => {
    const html = renderWebsiteMarkdown(
      'hello <script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))',
    )

    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('javascript:')
  })
})
