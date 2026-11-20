import { describe, expect, it } from 'vitest'
import { isRevisioned, isTextDocument, isTextFile, mimeFor, officeKind, parseCsv, previewKind } from './preview'

describe('previewKind', () => {
  it.each([
    ['notes.md', 'text/markdown', 'markdown'],
    ['table.CSV', 'text/csv', 'csv'],
    ['scan.pdf', 'application/pdf', 'pdf'],
    ['logo.png', 'image/png', 'image'],
    ['photo', 'image/jpeg', 'image'],
    ['readme.txt', 'text/plain', 'text'],
    ['index.html', 'text/html', 'html'],
    ['Report.HTM', '', 'html'],
    ['page', 'text/html', 'html'],
    ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
    ['Deck.PPTX', '', 'pptx'],
    ['letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['letter.doc', 'application/msword', 'other'],
    ['archive.zip', 'application/zip', 'other'],
  ])('%s → %s', (name, mime, kind) => {
    expect(previewKind(name, mime)).toBe(kind)
  })
  it('revisions for markdown, csv and the office files; only markdown and csv are written as text', () => {
    expect(isRevisioned('a.md')).toBe(true)
    expect(isRevisioned('a.csv')).toBe(true)
    expect(isRevisioned('a.pdf')).toBe(true)
    expect(isRevisioned('a.docx')).toBe(true)
    expect(isRevisioned('a.pptx')).toBe(true)
    expect(isRevisioned('a.txt')).toBe(false)
    expect(isTextDocument('a.md')).toBe(true)
    expect(isTextDocument('a.csv')).toBe(true)
    expect(isTextDocument('a.pdf')).toBe(false)
    expect(isTextFile('a.txt', 'text/plain')).toBe(true)
    expect(isTextFile('a.pdf', 'application/pdf')).toBe(false)
    // HTML renders as a page but stays readable as text for the agent (drive.read).
    expect(isTextFile('index.html', 'text/html')).toBe(true)
  })
  it('officeKind names the office format, else null', () => {
    expect(officeKind('a.pdf', '')).toBe('pdf')
    expect(officeKind('scan', 'application/pdf')).toBe('pdf')
    expect(officeKind('a.docx', '')).toBe('docx')
    expect(officeKind('a.pptx', '')).toBe('pptx')
    expect(officeKind('a.md', 'text/markdown')).toBeNull()
  })
  it('mimeFor fills the office types from the extension', () => {
    expect(mimeFor('a.docx', null)).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(mimeFor('a.pptx', 'application/octet-stream')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
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
