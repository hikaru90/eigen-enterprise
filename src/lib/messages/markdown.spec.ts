import { describe, expect, it } from 'vitest'
import { renderMessageMarkdown } from './markdown'

describe('renderMessageMarkdown', () => {
  it('renders GFM basics', () => {
    const html = renderMessageMarkdown('**bold** _it_ `code`\n- a\n- b')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>it</em>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<li>a</li>')
  })

  it('never renders raw HTML or scripts', () => {
    const html = renderMessageMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)> <b>x</b>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('drops javascript: links and hardens real ones', () => {
    expect(renderMessageMarkdown('[x](javascript:alert(1))')).not.toContain('javascript:')
    const html = renderMessageMarkdown('[site](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
  })

  it('strips event handler attributes even from allowed tags', () => {
    const html = renderMessageMarkdown('<a href="https://x.test" onclick="steal()">a</a> [b](https://y.test "t")')
    expect(html).not.toMatch(/<[^>]*\sonclick=/)
    expect(html).toContain('href="https://y.test"')
  })
})
