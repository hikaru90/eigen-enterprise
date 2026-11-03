import { describe, expect, it } from 'vitest'
import { isRevisioned, isTextFile, mimeFor, parseCsv, previewKind } from './preview'

describe('previewKind', () => {
  it.each([
    ['notes.md', 'text/markdown', 'markdown'],
    ['table.CSV', 'text/csv', 'csv'],
    ['scan.pdf', 'application/pdf', 'pdf'],
    ['logo.png', 'image/png', 'image'],
    ['photo', 'image/jpeg', 'image'],
    ['readme.txt', 'text/plain', 'text'],
    ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'other'],
  ])('%s → %s', (name, mime, kind) => {
    expect(previewKind(name, mime)).toBe(kind)
  })
  it('revisions only for markdown and csv; text files are readable', () => {
    expect(isRevisioned('a.md')).toBe(true)
    expect(isRevisioned('a.csv')).toBe(true)
    expect(isRevisioned('a.txt')).toBe(false)
    expect(isTextFile('a.txt', 'text/plain')).toBe(true)
    expect(isTextFile('a.pdf', 'application/pdf')).toBe(false)
  })
  it('mimeFor keeps the browser type and fills it from the extension', () => {
    expect(mimeFor('a.pdf', 'application/pdf')).toBe('application/pdf')
    expect(mimeFor('a.md', '')).toBe('text/markdown')
    expect(mimeFor('a.bin', null)).toBe('application/octet-stream')
  })
})

describe('parseCsv', () => {
  it('parses quotes, doubled quotes, embedded newlines and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
    ])
  })
  it('handles a last row without newline and empty input', () => {
    expect(parseCsv('a,b')).toEqual([['a', 'b']])
    expect(parseCsv('')).toEqual([])
  })
})
