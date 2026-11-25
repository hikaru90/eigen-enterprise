import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { runClear, runMerge, runShiftDecimals } from './cells-edit'
import { readClip } from './clip'
import { createSheetEditor } from './editor'
import { FORMAT_CHOICES, shiftDecimals } from './format'
import { mergeLosses } from './merge'
import { cellKey, requireRange } from './ref'
import { budgetBook, buildXlsx, cse, num, row, str } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

describe('merge, clear, format painter, number formats & decimals', () => {
  it('merge & center / merge / merge across / unmerge update XML and report merged_values loss', () => {
    const ed = createSheetEditor(
      buildXlsx({
        strings: ['Title', 'Sub', 'R2A', 'R2B'],
        sheets: [
          {
            name: 'S',
            rows: row(1, str('A1', 0) + str('B1', 1)) + row(2, str('A2', 2) + str('B2', 3)),
          },
        ],
      }),
    )
    const op = { op: 'merge_cells' as const, sheet: 'S', range: 'A1:B1', mode: 'center' as const }
    expect(mergeLosses(ed.wb, op)).toEqual([{ feature: 'merged_values', count: 1 }])
    expect(() => ed.apply(op)).toThrow(/merged cells/)
    ed.apply(op, { acceptLosses: true })

    const wb = openWorkbook(ed.toBytes())
    const s = wb.sheet('S')
    expect(s.merges).toEqual([{ top: 0, left: 0, bottom: 0, right: 1 }])
    expect(s.cells.get(cellKey(0, 0))?.value).toBe('Title')
    expect(s.cells.get(cellKey(0, 1))?.value).toBeNull()
    expect(wb.styles().xf(s.cells.get(cellKey(0, 0))!.style).horizontal).toBe('center')
    const sheetXml = strFromU8(unzipSync(ed.toBytes())['xl/worksheets/sheet1.xml']!)
    expect(sheetXml).toContain('<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>')

    // Merge across creates one merge per row
    ed.apply(
      { op: 'merge_cells', sheet: 'S', range: 'A2:C3', mode: 'across' },
      { acceptLosses: true },
    )
    expect(ed.wb.sheet('S').merges).toEqual([
      { top: 0, left: 0, bottom: 0, right: 1 },
      { top: 1, left: 0, bottom: 1, right: 2 },
      { top: 2, left: 0, bottom: 2, right: 2 },
    ])

    // Unmerge removes intersecting merges
    ed.apply({ op: 'merge_cells', sheet: 'S', range: 'A2:C3', mode: 'unmerge' })
    expect(ed.wb.sheet('S').merges).toEqual([{ top: 0, left: 0, bottom: 0, right: 1 }])

    void runMerge
  })

  it('refuses merging over a legacy array formula', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [{ name: 'S', rows: row(1, cse('A1', 'A1:B1', '1', 1)) }],
      }),
    )
    expect(() =>
      ed.apply({ op: 'merge_cells', sheet: 'S', range: 'A1:B1', mode: 'merge' }),
    ).toThrow(/array formula/)
  })

  it('clear supports contents, formats, and all (and unmerges on formats/all)', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({ op: 'clear_range', sheet: 'Budget', range: 'B2', what: 'contents' })
    expect(ed.wb.sheet('Budget').cells.get(cellKey(1, 1))?.value).toBeNull()
    expect(ed.wb.styles().xf(ed.wb.sheet('Budget').cells.get(cellKey(1, 1))!.style).fill).toBe(
      '#FFFF00',
    )

    ed.apply({ op: 'clear_range', sheet: 'Budget', range: 'A1:F1', what: 'formats' })
    expect(ed.wb.sheet('Budget').cells.get(cellKey(0, 0))?.value).toBe('Item')
    expect(ed.wb.sheet('Budget').cells.get(cellKey(0, 0))?.style).toBe(0)
    expect(ed.wb.sheet('Budget').merges).toEqual([])

    ed.apply({ op: 'clear_range', sheet: 'Budget', range: 'A3:B3', what: 'all' })
    expect(ed.wb.sheet('Budget').cells.get(cellKey(2, 0))).toBeUndefined()
    void runClear
  })

  it('format painter copies styles & merges without touching values', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({
      op: 'set_style',
      sheet: 'Budget',
      range: 'A2',
      style: { bold: true, border: { preset: 'outer' } },
    })
    const clip = readClip(ed, 'Budget', requireRange('A2:B2'), 'b1')
    ed.apply({ op: 'paste', sheet: 'Budget', at: 'A3:B3', clip, paste: 'formats' })
    expect(ed.wb.sheet('Budget').cells.get(cellKey(2, 0))?.value).toBe('Food')
    expect(ed.wb.styles().xf(ed.wb.sheet('Budget').cells.get(cellKey(2, 0))!.style).font.bold).toBe(
      true,
    )
    expect(ed.wb.styles().xf(ed.wb.sheet('Budget').cells.get(cellKey(2, 1))!.style).fill).toBe(
      '#FFFF00',
    )
  })

  it('shifts decimals across General, fixed, percent, currency and accounting formats', () => {
    expect(shiftDecimals('General', 1, 1.25)).toBe('0.000')
    expect(shiftDecimals('General', 1, 10)).toBe('0.0')
    expect(shiftDecimals('0', 1)).toBe('0.0')
    expect(shiftDecimals('0.0', -1)).toBe('0')
    expect(shiftDecimals('#,##0.00', 1)).toBe('#,##0.000')
    expect(shiftDecimals('#,##0.00', -1)).toBe('#,##0.0')
    expect(shiftDecimals('0.00%', 1)).toBe('0.000%')
    expect(shiftDecimals('_-[$$-409]* #,##0.00_ ;_-[$$-409]* (#,##0.00)', 1)).toBe(
      '_-[$$-409]* #,##0.000_ ;_-[$$-409]* (#,##0.000)',
    )
    expect(FORMAT_CHOICES.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        'general',
        'number',
        'currency_usd',
        'accounting',
        'date',
        'time',
        'percent',
        'fraction',
        'scientific',
        'text',
      ]),
    )

    const ed = createSheetEditor(
      buildXlsx({
        sheets: [{ name: 'S', rows: row(1, num('A1', 12.3) + num('B1', 0.25, 3)) }],
      }),
    )
    ed.apply({ op: 'shift_decimals', sheet: 'S', range: 'A1:B1', delta: 1 })
    expect(ed.wb.styles().xf(ed.wb.sheet('S').cells.get(cellKey(0, 0))!.style).numFmt).toBe('0.00')
    expect(ed.wb.styles().xf(ed.wb.sheet('S').cells.get(cellKey(0, 1))!.style).numFmt).toBe('0.00%')
    void runShiftDecimals
  })
})
