import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { XlsxLossError } from './ops'
import { cellKey } from './ref'
import { sheetTabColor, sheetTabLosses } from './sheet-tabs'
import { budgetBook, buildXlsx, num, row } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

describe('sheet tabs: reorder, colour, hide/unhide, duplicate', () => {
  it('reorders tabs and remaps localSheetId defined names and workbookView activeTab', () => {
    const ed = createSheetEditor(
      buildXlsx({
        definedNames: '<definedName name="LocalN" localSheetId="0">Budget!$A$1</definedName>',
        sheets: [
          { name: 'Budget', rows: row(1, num('A1', 10)) },
          { name: 'Summary', rows: row(1, num('A1', 20)) },
          { name: 'Notes' },
        ],
      }),
    )
    ed.apply({ op: 'move_sheet', sheet: 'Budget', to: 2 })
    const wb = openWorkbook(ed.toBytes())
    expect(wb.sheets().map((s) => s.name)).toEqual(['Summary', 'Notes', 'Budget'])
    expect(wb.definedNames()).toEqual([
      { name: 'LocalN', localSheet: 2, formula: 'Budget!$A$1', hidden: false },
    ])
  })

  it('sets and clears tab colour (<sheetPr><tabColor>)', () => {
    const ed = createSheetEditor(budgetBook())
    expect(sheetTabColor(ed.wb, 'Budget')).toBeNull()
    ed.apply({ op: 'set_sheet_color', sheet: 'Budget', color: '#1f4e79' })
    expect(sheetTabColor(openWorkbook(ed.toBytes()), 'Budget')).toBe('#1F4E79')
    ed.apply({ op: 'set_sheet_color', sheet: 'Budget', color: null })
    expect(sheetTabColor(openWorkbook(ed.toBytes()), 'Budget')).toBeNull()
  })

  it('hides and unhides sheets, refusing to hide the last visible sheet', () => {
    const ed = createSheetEditor(budgetBook())
    const res = ed.apply({ op: 'set_sheet_visibility', sheet: 'Budget', state: 'hidden' })
    expect(res.focus).toBe('Summary')
    expect(openWorkbook(ed.toBytes()).requireSheet('Budget').state).toBe('hidden')
    expect(() =>
      ed.apply({ op: 'set_sheet_visibility', sheet: 'Summary', state: 'hidden' }),
    ).toThrow(/at least one visible sheet/)
    ed.apply({ op: 'set_sheet_visibility', sheet: 'Budget', state: 'visible' })
    expect(ed.wb.requireSheet('Budget').state).toBe('visible')
  })

  it('duplicates a sheet with cells, merges, styles, external hyperlinks and local names, and reports non-copied parts as losses', () => {
    const ed = createSheetEditor(
      buildXlsx({
        definedNames: '<definedName name="Area" localSheetId="0">Budget!$A$1</definedName>',
        sheets: [
          {
            name: 'Budget',
            rows: row(1, num('A1', 99, 2)),
            after: '<mergeCells count="1"><mergeCell ref="B1:C1"/></mergeCells>',
          },
          { name: 'Summary' },
        ],
      }),
    )
    ed.apply({ op: 'duplicate_sheet', sheet: 'Budget' })
    const wb = openWorkbook(ed.toBytes())
    expect(wb.sheets().map((s) => s.name)).toEqual(['Budget', 'Budget (2)', 'Summary'])
    expect(wb.sheet('Budget (2)').cells.get(cellKey(0, 0))).toMatchObject({ value: 99, style: 2 })
    expect(wb.sheet('Budget (2)').merges).toEqual([{ top: 0, left: 1, bottom: 0, right: 2 }])
    expect(wb.definedNames().find((n) => n.localSheet === 1)?.formula).toBe("'Budget (2)'!$A$1")

    // With drawing relationship -> loss reported unless accepted
    const withDrawing = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows: row(1, num('A1', 1)),
            after: '<drawing r:id="rId1"/>',
            rels: [{ id: 'rId1', type: 'drawing', target: '../drawings/drawing1.xml' }],
          },
        ],
        parts: {
          '/xl/drawings/drawing1.xml': {
            xml: '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>',
            type: 'application/vnd.openxmlformats-officedocument.drawing+xml',
          },
        },
      }),
    )
    expect(sheetTabLosses(withDrawing.wb, { op: 'duplicate_sheet', sheet: 'S' })).toEqual([
      { feature: 'not_copied', count: 1 },
    ])
    expect(() => withDrawing.apply({ op: 'duplicate_sheet', sheet: 'S', name: 'Copy' })).toThrow(
      XlsxLossError,
    )
    withDrawing.apply({ op: 'duplicate_sheet', sheet: 'S', name: 'Copy' }, { acceptLosses: true })
    expect(withDrawing.wb.sheets().map((s) => s.name)).toEqual(['S', 'Copy'])
  })
})
