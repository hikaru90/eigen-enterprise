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

  it('highlights @mentions of known people, the longest name first, yours as "me"', () => {
    const people = { names: ['Bea Member', 'Bea', 'Carl'], me: ['Carl'] }
    expect(renderMessageMarkdown('hi @Bea Member and @carl!', people)).toBe(
      '<p>hi <span data-mention="other">@Bea Member</span> and <span data-mention="me">@carl</span>!</p>\n',
    )
    expect(renderMessageMarkdown('@Bea, look', people)).toContain('<span data-mention="other">@Bea</span>,')
  })

  it('leaves unknown names, emails, partial words and code alone; a typed span stays text', () => {
    const people = { names: ['Bea Member', 'Bea', 'Carl'], me: ['Carl'] }
    expect(renderMessageMarkdown('@Dan bea@co.test @Beatrice `@Bea`', people)).not.toContain('data-mention')
    expect(renderMessageMarkdown('@Bea', { names: [] })).toBe('<p>@Bea</p>\n')
    expect(renderMessageMarkdown('<span data-mention="me">x</span>', people)).not.toContain('<span')
  })

  it('strips event handler attributes even from allowed tags', () => {
    const html = renderMessageMarkdown('<a href="https://x.test" onclick="steal()">a</a> [b](https://y.test "t")')
    expect(html).not.toMatch(/<[^>]*\sonclick=/)
    expect(html).toContain('href="https://y.test"')
  })
})
