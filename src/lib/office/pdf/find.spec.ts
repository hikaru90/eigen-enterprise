import { describe, expect, it } from 'vitest'
import { findInPage, itemRanges, pageName, pageText, resolvePageInput } from './find'

const items = [
  { str: 'Revenue grew in every ', hasEOL: false },
  { str: 'region', hasEOL: true },
  { str: 'and costs fell.', hasEOL: false },
]

describe('find in a PDF', () => {
  it("joins a page's items, a line end counting as a space", () => {
    const t = pageText(items)
    expect(t.text).toBe('Revenue grew in every region and costs fell.')
    expect(t.starts).toEqual([0, 22, 29])
  })

  it('finds every match, ignoring case, also across items and lines', () => {
    const t = pageText(items)
    expect(findInPage(t, 'REGION and')).toEqual([{ start: 22, end: 32 }])
    expect(findInPage(t, 'e')).toHaveLength(8)
    expect(findInPage(t, '')).toEqual([])
    expect(findInPage(t, '   ')).toEqual([])
  })

  it('maps a match back to the parts of each text item it covers', () => {
    const t = pageText(items)
    expect(itemRanges(t, 16, 32)).toEqual([
      { item: 0, from: 16, to: 22 },
      { item: 1, from: 0, to: 6 },
      { item: 2, from: 0, to: 3 },
    ])
  })
})

describe('page names and go-to-page', () => {
  const labels = ['Cover', 'i', 'ii', '1', '2']

  it('names a page by its label, else its number', () => {
    expect(pageName(labels, 1)).toBe('i')
    expect(pageName(null, 1)).toBe('2')
    expect(pageName(['', 'x'], 0)).toBe('1')
  })

  it('goes to a page by its label first, then by its number', () => {
    expect(resolvePageInput('ii', labels, 5)).toBe(2)
    expect(resolvePageInput(' Cover ', labels, 5)).toBe(0)
    expect(resolvePageInput('1', labels, 5)).toBe(3)
    expect(resolvePageInput('5', labels, 5)).toBe(4)
    expect(resolvePageInput('5', null, 5)).toBe(4)
    expect(resolvePageInput('6', null, 5)).toBeNull()
    expect(resolvePageInput('0', null, 5)).toBeNull()
    expect(resolvePageInput('two', null, 5)).toBeNull()
  })
})
