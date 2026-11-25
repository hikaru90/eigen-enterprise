import { describe, expect, it } from 'vitest'
import { borderCss, fontFamilyCss, verticalOf } from './grid-style'
import { readStyles, type CellBorders } from './styles'

const none: CellBorders = { left: null, right: null, top: null, bottom: null }
const plain = readStyles(null, null).xf(0)
const n = (over: Partial<Parameters<typeof borderCss>[1]> = {}) => ({
  right: null,
  below: null,
  firstCol: false,
  firstRow: false,
  filled: false,
  ...over,
})

describe('grid style', () => {
  it('draws a cell’s own right/bottom edge, else the neighbour’s facing one, each once', () => {
    const red = { style: 'medium', color: '#C00000' }
    expect(borderCss({ ...none, bottom: red }, n())).toEqual(['border-bottom: 2px solid #C00000'])
    expect(
      borderCss(none, n({ right: { ...none, left: { style: 'dashed', color: null } } })),
    ).toEqual(['border-right: 1px dashed var(--foreground, currentColor)'])
    // A left edge is the left neighbour's to draw, except in the first column.
    expect(borderCss({ ...none, left: red }, n())).toEqual([])
    expect(
      borderCss({ ...none, left: red, top: red }, n({ firstCol: true, firstRow: true })),
    ).toEqual(['box-shadow: inset 2px 0px 0 #C00000, inset 0px 2px 0 #C00000'])
    // Black follows the theme unless the cell is filled.
    const black = { style: 'thin', color: '#000000' }
    expect(borderCss({ ...none, right: black }, n())).toEqual([
      'border-right: 1px solid var(--foreground, currentColor)',
    ])
    expect(borderCss({ ...none, right: black }, n({ filled: true }))).toEqual([
      'border-right: 1px solid #000000',
    ])
  })

  it('names a font family only when it differs from the plain one, without CSS syntax', () => {
    expect(fontFamilyCss(plain, plain)).toBeNull()
    expect(fontFamilyCss({ ...plain, font: { ...plain.font, name: 'Arial' } }, plain)).toBe(
      'font-family: "Arial", sans-serif',
    )
    expect(
      fontFamilyCss({ ...plain, font: { ...plain.font, name: 'x"; color: red' } }, plain),
    ).toBe('font-family: "x color red", sans-serif')
  })

  it('places text vertically as Excel does (bottom by default)', () => {
    expect(verticalOf(plain)).toBe('bottom')
    expect(verticalOf({ ...plain, vertical: 'top' })).toBe('top')
    expect(verticalOf({ ...plain, vertical: 'center' })).toBe('center')
  })
})
