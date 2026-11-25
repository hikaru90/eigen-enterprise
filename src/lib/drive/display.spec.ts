import { describe, expect, it } from 'vitest'
import { datedLabel, driveItemKind, hasThumbnail, initialsOf, shortWhen, textPreviewOf, TEXT_PREVIEW_MAX_BYTES } from './display'

describe('driveItemKind', () => {
  it('reads the kind from type, extension and MIME type', () => {
    expect(driveItemKind({ type: 'folder', name: 'Projects' })).toBe('folder')
    expect(driveItemKind({ type: 'file', name: 'notes.MD' })).toBe('document')
    expect(driveItemKind({ type: 'file', name: 'readme.txt' })).toBe('document')
    expect(driveItemKind({ type: 'file', name: 'budget.csv', mime: 'text/csv' })).toBe('table')
    expect(driveItemKind({ type: 'file', name: 'mood.png', mime: 'image/png' })).toBe('image')
    expect(driveItemKind({ type: 'file', name: 'brief.pdf', mime: 'application/pdf' })).toBe('pdf')
    expect(driveItemKind({ type: 'file', name: 'Letter.DOCX', mime: 'application/octet-stream' })).toBe('word')
    expect(driveItemKind({ type: 'file', name: 'pitch.pptx' })).toBe('slides')
    expect(driveItemKind({ type: 'file', name: 'Budget.XLSX' })).toBe('sheet')
    expect(
      driveItemKind({ type: 'file', name: 'data.bin', mime: 'application/octet-stream' }),
    ).toBe('file')
  })
})

describe('hasThumbnail', () => {
  it('previews raster images (png, jpg, webp, gif, avif, bmp), not SVG (served as text) or other files', () => {
    for (const [name, mime] of [
      ['a.png', 'image/png'],
      ['a.jpg', 'image/jpeg'],
      ['a.webp', 'image/webp'],
      ['a.gif', 'image/gif'],
      ['a.avif', 'image/avif'],
      ['a.bmp', 'image/bmp'],
    ])
      expect(hasThumbnail({ type: 'file', name, mime })).toBe(true)
    expect(hasThumbnail({ type: 'file', name: 'logo.svg', mime: 'image/svg+xml' })).toBe(false)
    expect(hasThumbnail({ type: 'file', name: 'brief.pdf', mime: 'application/pdf' })).toBe(false)
    expect(hasThumbnail({ type: 'folder', name: 'Photos' })).toBe(false)
  })
})

describe('textPreviewOf', () => {
  it('previews documents and plain-text formats as text, CSV as a table, nothing else', () => {
    expect(textPreviewOf({ type: 'file', name: 'notes.md', size: 10 })).toBe('text')
    expect(textPreviewOf({ type: 'file', name: 'readme.txt' })).toBe('text')
    expect(textPreviewOf({ type: 'file', name: 'config.JSON' })).toBe('text')
    expect(textPreviewOf({ type: 'file', name: 'budget.csv', mime: 'text/csv' })).toBe('table')
    expect(textPreviewOf({ type: 'file', name: 'mood.png', mime: 'image/png' })).toBe(null)
    expect(textPreviewOf({ type: 'file', name: 'brief.pdf', mime: 'application/pdf' })).toBe(null)
    expect(textPreviewOf({ type: 'folder', name: 'notes.md' })).toBe(null)
  })
  it('keeps the icon for files too large to load for a glance', () => {
    expect(textPreviewOf({ type: 'file', name: 'big.md', size: TEXT_PREVIEW_MAX_BYTES + 1 })).toBe(null)
  })
})

describe('datedLabel', () => {
  it('says the month and year a file is from, and what kind of date that is', () => {
    expect(datedLabel({ at: '2019-03-14T09:30:00.000Z', kind: 'taken' })).toEqual({
      month: 'Mar 2019',
      kind: 'taken',
      full: 'Taken March 2019',
    })
    expect(datedLabel({ at: new Date('1987-05-12T07:30:00.000Z'), kind: 'created' })).toEqual({
      month: 'May 1987',
      kind: 'created',
      full: 'Created May 1987',
    })
    expect(datedLabel({ at: '2026-11-04T10:00:00.000Z', kind: 'uploaded' }).full).toBe(
      'Uploaded November 2026',
    )
    expect(datedLabel({ at: '2026-11-04T10:00:00.000Z', kind: 'added' }).full).toBe(
      'Added November 2026',
    )
  })

  it('keeps a recorded date’s own month at a month boundary (its wall clock is stored as UTC)', () => {
    expect(datedLabel({ at: '2019-03-31T23:30:00.000Z', kind: 'taken' }).month).toBe('Mar 2019')
    expect(datedLabel({ at: '2019-04-01T00:15:00.000Z', kind: 'created' }).month).toBe('Apr 2019')
  })
})

describe('initialsOf', () => {
  it('takes the first letters of the first two words', () => {
    expect(initialsOf('Ada Owner')).toBe('AO')
    expect(initialsOf('  ben  de   member ')).toBe('BD')
    expect(initialsOf('messages')).toBe('M')
    expect(initialsOf('')).toBe('')
  })
})

describe('shortWhen', () => {
  const now = new Date(2026, 10, 4, 15, 0)
  it('says the time today, "Yesterday", then a short date (the year only when not this year)', () => {
    expect(shortWhen(new Date(2026, 10, 4, 9, 30), now)).toMatch(/9|09/)
    expect(shortWhen(new Date(2026, 10, 3, 23, 0), now)).toBe('Yesterday')
    expect(shortWhen(new Date(2026, 9, 1), now)).not.toMatch(/2026/)
    expect(shortWhen(new Date(2025, 9, 1), now)).toMatch(/2025/)
  })
})
