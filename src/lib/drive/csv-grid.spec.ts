import { describe, expect, it } from 'vitest'
import { parseCsv as previewParse } from '../../../modules/drive/preview'
import {
  emptyGrid,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseClipboardBlock,
  parseCsv,
  pasteBlock,
  removeColumn,
  removeRow,
  serializeCsv,
  setCell,
} from './csv-grid'

describe('csv grid: RFC 4180 parse/serialize', () => {
  it('parses quotes, doubled quotes, commas and line breaks inside cells', () => {
    const text = 'name,note\r\n"Smith, Ann","said ""hi""\nthen left"\r\nBob,\r\n'
    expect(parseCsv(text)).toEqual([
      ['name', 'note'],
      ['Smith, Ann', 'said "hi"\nthen left'],
      ['Bob', ''],
    ])
  })

  it('accepts LF line breaks and a missing final line break', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('pads short rows so the grid is rectangular', () => {
    expect(parseCsv('a,b,c\n1\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ])
  })

  it('serializes with CRLF and quotes only where needed', () => {
    expect(serializeCsv([['a', 'b,c'], ['say "x"', 'line\nbreak'], [' lead', '']])).toBe('a,"b,c"\r\n"say ""x""","line\nbreak"\r\n" lead",\r\n')
  })

  it('round-trips arbitrary cells exactly (grid → text → grid)', () => {
    const grids = [
      [['h1', 'h2'], ['', '']],
      [['quote "inside"', ',', '\r\n'], ['"', '""', 'a\nb\nc']],
      [['ünïcødé ✓', '=SUM(A1)', 'tab\there']],
      [['only']],
    ]
    for (const g of grids) expect(parseCsv(serializeCsv(g))).toEqual(g)
  })

  it('round-trips files (text → grid → text) once normalized to CRLF', () => {
    const text = 'id,name,comment\r\n1,"Doe, J.","multi\nline"\r\n2,X,""""\r\n'
    expect(serializeCsv(parseCsv(text))).toBe(text)
  })

  it('agrees with the preview parser on what it serializes', () => {
    const g = [['a', 'b,c'], ['"q"', 'x\ny']]
    expect(previewParse(serializeCsv(g))).toEqual(g)
  })

  it('empty text is an empty grid and back', () => {
    expect(parseCsv('')).toEqual([])
    expect(serializeCsv([])).toBe('')
  })

  it('fails loud on malformed CSV (an unclosed quote)', () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow(/not valid CSV/)
  })
})

describe('csv grid: operations', () => {
  const g = [
    ['A', 'B'],
    ['1', '2'],
    ['3', '4'],
  ]

  it('edits a cell without touching the input', () => {
    const next = setCell(g, 1, 1, 'x')
    expect(next[1]).toEqual(['1', 'x'])
    expect(g[1]).toEqual(['1', '2'])
  })

  it('adds, removes and moves rows', () => {
    expect(insertRow(g, 1)).toEqual([['A', 'B'], ['', ''], ['1', '2'], ['3', '4']])
    expect(insertRow(g, 99).at(-1)).toEqual(['', ''])
    expect(removeRow(g, 1)).toEqual([['A', 'B'], ['3', '4']])
    expect(moveRow(g, 2, 1)).toEqual([['A', 'B'], ['3', '4'], ['1', '2']])
  })

  it('adds, removes and moves columns (the header gets the name)', () => {
    expect(insertColumn(g, 1, 'New')).toEqual([['A', 'New', 'B'], ['1', '', '2'], ['3', '', '4']])
    expect(insertColumn(g, 2, 'C').map((r) => r.length)).toEqual([3, 3, 3])
    expect(removeColumn(g, 0)).toEqual([['B'], ['2'], ['4']])
    expect(removeColumn([['A'], ['1']], 0)).toEqual([])
    expect(moveColumn(g, 0, 1)).toEqual([['B', 'A'], ['2', '1'], ['4', '3']])
  })

  it('a new table has a header row and an empty row', () => {
    expect(emptyGrid(2)).toEqual([['Column 1', 'Column 2'], ['', '']])
  })
})

describe('csv grid: paste a spreadsheet block', () => {
  it('parses tab-separated lines, including spreadsheet-quoted cells', () => {
    expect(parseClipboardBlock('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseClipboardBlock('"two\nlines"\tx\n')).toEqual([['two\nlines', 'x']])
    expect(parseClipboardBlock('single')).toEqual([['single']])
  })

  it('writes the block at the cursor and grows the grid as needed', () => {
    const g = [['A', 'B'], ['1', '2']]
    expect(pasteBlock(g, 1, 1, [['x', 'y'], ['z', 'w']])).toEqual([
      ['A', 'B', ''],
      ['1', 'x', 'y'],
      ['', 'z', 'w'],
    ])
    expect(pasteBlock(g, 0, 0, [['p']])).toEqual([['p', 'B'], ['1', '2']])
  })
})
