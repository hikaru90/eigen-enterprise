import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { cellKey } from './ref'
import {
  formatAt,
  formatRange,
  isPlain,
  normalizeRuns,
  retext,
  richCells,
  runCss,
  runsText,
} from './rich-text'
import { buildXlsx, cse, row } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

describe('rich text runs inside a cell', () => {
  it('writes rich text runs to sharedStrings, reads them back on reopen, and reuses identical items', () => {
    const ed = createSheetEditor(buildXlsx({ sheets: [{ name: 'S' }] }))
    ed.apply({
      op: 'set_rich_text',
      sheet: 'S',
      ref: 'A1',
      runs: [
        { text: 'Bold ', bold: true, color: '#1F4E79' },
        { text: 'and ', italic: true, underline: true },
        { text: 'struck', strike: true, size: 14, font: 'Georgia' },
      ],
    })
    ed.apply({
      op: 'set_rich_text',
      sheet: 'S',
      ref: 'B1',
      runs: [
        { text: 'Bold ', bold: true, color: '#1F4E79' },
        { text: 'and ', italic: true, underline: true },
        { text: 'struck', strike: true, size: 14, font: 'Georgia' },
      ],
    })
    const bytes = ed.toBytes()
    const wb = openWorkbook(bytes)
    expect(wb.sheet('S').cells.get(cellKey(0, 0))?.value).toBe('Bold and struck')
    const map = richCells(wb, 'S')
    expect(map.get(cellKey(0, 0))).toEqual([
      { text: 'Bold ', bold: true, color: '#1F4E79' },
      { text: 'and ', italic: true, underline: true },
      { text: 'struck', strike: true, size: 14, font: 'Georgia' },
    ])
    expect(map.get(cellKey(0, 1))).toEqual(map.get(cellKey(0, 0)))
    const sst = strFromU8(unzipSync(bytes)['xl/sharedStrings.xml']!)
    expect(sst.match(/<si>/g)?.length).toBe(1)
  })

  it('normalizes adjacent identical runs, collapses plain runs, and clears empty text', () => {
    const norm = normalizeRuns([
      { text: 'a', bold: true },
      { text: '' },
      { text: 'b', bold: true },
      { text: 'c' },
    ])
    expect(norm).toEqual([{ text: 'ab', bold: true }, { text: 'c' }])
    expect(isPlain([{ text: 'plain' }])).toBe(true)

    const ed = createSheetEditor(buildXlsx({ sheets: [{ name: 'S' }] }))
    ed.apply({ op: 'set_rich_text', sheet: 'S', ref: 'A1', runs: [{ text: 'Plain' }] })
    expect(richCells(ed.wb, 'S').size).toBe(0)
    expect(ed.wb.sheet('S').cells.get(cellKey(0, 0))?.value).toBe('Plain')
    ed.apply({ op: 'set_rich_text', sheet: 'S', ref: 'A1', runs: [{ text: '' }] })
    expect(ed.wb.sheet('S').cells.get(cellKey(0, 0))).toBeUndefined()
  })

  it('edits sub-ranges and text changes while keeping untouched run formatting', () => {
    const initial = [{ text: 'Hello world', bold: true }]
    const patched = formatRange(initial, 6, 11, { bold: false, italic: true, color: '#C00000' })
    expect(patched).toEqual([
      { text: 'Hello ', bold: true },
      { text: 'world', italic: true, color: '#C00000' },
    ])
    expect(formatAt(patched, 3)).toEqual({ bold: true })
    expect(formatAt(patched, 8)).toEqual({ italic: true, color: '#C00000' })

    const edited = retext(patched, 'Hello world', 'Hello big world')
    expect(runsText(edited)).toBe('Hello big world')
    expect(edited[0]).toEqual({ text: 'Hello big ', bold: true })
    expect(edited[1]).toEqual({ text: 'world', italic: true, color: '#C00000' })
    expect(
      runCss({ bold: true, italic: true, underline: true, color: '#C00000', size: 12 }),
    ).toContain('font-weight: 600')
  })

  it('reads inlineStr rich text and refuses array / non-anchor merged cells', () => {
    const wb = openWorkbook(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows:
              row(
                1,
                '<c r="A1" t="inlineStr"><is><r><rPr><b/></rPr><t>Hi</t></r><r><t>!</t></r></is></c>',
              ) + row(2, cse('A2', 'A2:B2', '1', 1)),
            after: '<mergeCells count="1"><mergeCell ref="C1:D1"/></mergeCells>',
          },
        ],
      }),
    )
    expect(richCells(wb, 'S').get(cellKey(0, 0))).toEqual([
      { text: 'Hi', bold: true },
      { text: '!' },
    ])

    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows: row(2, cse('A2', 'A2:B2', '1', 1)),
            after: '<mergeCells count="1"><mergeCell ref="C1:D1"/></mergeCells>',
          },
        ],
      }),
    )
    expect(() =>
      ed.apply({ op: 'set_rich_text', sheet: 'S', ref: 'D1', runs: [{ text: 'x', bold: true }] }),
    ).toThrow(/merged cells/)
    expect(() =>
      ed.apply({ op: 'set_rich_text', sheet: 'S', ref: 'A2', runs: [{ text: 'x', bold: true }] }),
    ).toThrow(/array formula/)
  })
})
