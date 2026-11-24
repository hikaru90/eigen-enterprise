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

  it('renders internal /drive/folder and /drive/file links for SPA navigation with data-drive-link', () => {
    const folderHtml = renderMessageMarkdown('[Q4 Docs](/drive/folder/abc-123)')
    expect(folderHtml).toContain('<a href="/drive/folder/abc-123" data-drive-link="folder">Q4 Docs</a>')
    expect(folderHtml).not.toContain('target=')
    expect(folderHtml).not.toContain('rel=')

    const fileHtml = renderMessageMarkdown('[Spec](/drive/file/file_9)')
    expect(fileHtml).toContain('<a href="/drive/file/file_9" data-drive-link="file">Spec</a>')
    expect(fileHtml).not.toContain('target=')
    expect(fileHtml).not.toContain('rel=')

    const escaped = renderMessageMarkdown('[Budget \\[2026\\]](/drive/folder/f2)')
    expect(escaped).toContain('<a href="/drive/folder/f2" data-drive-link="folder">Budget [2026]</a>')
  })

  it('rejects non-Drive internal paths, traversal, queries, and spoofed data-drive-link in raw HTML', () => {
    for (const target of [
      '/drive/folder/abc/../secret',
      '/drive/folder/abc?q=1',
      '/settings',
      '//evil.com/drive/folder/1',
    ]) {
      const html = renderMessageMarkdown(`[x](${target})`)
      expect(html).not.toContain('href=')
      expect(html).not.toContain('data-drive-link')
    }

    const raw = renderMessageMarkdown('<a href="https://example.com" data-drive-link="folder">x</a>')
    expect(raw).not.toMatch(/<a [^>]*data-drive-link/)
    expect(raw).toContain('&lt;a ')
  })
})

describe('renderMessageMarkdown — the author’s line breaks', () => {
  it('a single line break is a <br>', () => {
    expect(renderMessageMarkdown('a\nb')).toBe('<p>a<br>b</p>\n')
  })

  it('each empty line between blocks is kept as an empty line, never collapsed', () => {
    expect(renderMessageMarkdown('a\n\nb')).toBe('<p>a</p>\n<br>\n<p>b</p>\n')
    expect(renderMessageMarkdown('a\n\n\n\nb')).toBe('<p>a</p>\n<br><br><br>\n<p>b</p>\n')
    expect(renderMessageMarkdown('- x\n- y\n\n\nc')).toContain('</ul>\n<br><br>\n<p>c</p>')
  })

  it('no empty lines before the first or after the last block; code blocks keep their own', () => {
    expect(renderMessageMarkdown('a\n\n\n')).toBe('<p>a</p>\n')
    expect(renderMessageMarkdown('```\nx\n\n\ny\n```')).toBe('<pre><code>x\n\n\ny\n</code></pre>\n')
  })
})
