import { describe, expect, it } from 'vitest'
import { attachmentMarker, QUOTE_SNIPPET_MAX, quoteSnippet } from './quote'

describe('quoteSnippet (the first line of a quoted message)', () => {
  it('is the first non-empty line, trimmed', () => {
    expect(quoteSnippet('\n\n  hello there  \nsecond line')).toBe('hello there')
  })

  it('is cut at the maximum with an ellipsis', () => {
    const long = 'x'.repeat(QUOTE_SNIPPET_MAX + 20)
    const s = quoteSnippet(long)
    expect(s).toHaveLength(QUOTE_SNIPPET_MAX)
    expect(s.endsWith('…')).toBe(true)
  })

  it('is empty for an empty body (a file-only message)', () => {
    expect(quoteSnippet('')).toBe('')
  })
})

describe('attachmentMarker (what a quote says about the files)', () => {
  it('none without files', () => {
    expect(attachmentMarker([])).toBeNull()
  })

  it('an audio file is a voice message; an image a photo; anything else the file name', () => {
    expect(attachmentMarker([{ name: 'clip.webm', mime: 'audio/webm' }])).toEqual({ kind: 'voice', label: 'Voice message', count: 1 })
    expect(attachmentMarker([{ name: 'a.png', mime: 'image/png' }])).toEqual({ kind: 'image', label: 'Photo', count: 1 })
    expect(attachmentMarker([{ name: 'plan.pdf', mime: 'application/pdf' }])).toEqual({ kind: 'file', label: 'plan.pdf', count: 1 })
  })

  it('several files: the first one decides the kind, the count says how many', () => {
    expect(
      attachmentMarker([
        { name: 'a.png', mime: 'image/png' },
        { name: 'b.pdf', mime: 'application/pdf' },
      ]),
    ).toEqual({ kind: 'image', label: 'Photo', count: 2 })
  })
})
