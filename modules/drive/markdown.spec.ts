import { describe, expect, it } from 'vitest'
import { renderDriveMarkdown } from './markdown'

describe('renderDriveMarkdown', () => {
  it('renders headings, emphasis and GFM tables', () => {
    const html = renderDriveMarkdown('# Notes\n\n*hi*\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
    expect(html).toContain('<h1>Notes</h1>')
    expect(html).toContain('<em>hi</em>')
    expect(html).toContain('<table>')
  })
  it('strips scripts, event handlers and javascript: links', () => {
    const html = renderDriveMarkdown('<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n[x](javascript:alert(3))')
    expect(html).not.toMatch(/<script|onerror|javascript:/i)
  })
})
