import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createSheetEditor, workbookNotes } from './editor'
import { XlsxLossError } from './ops'
import { cellKey } from './ref'
import { budgetBook, buildXlsx, fml, num, row } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

const parts = (bytes: Uint8Array) => unzipSync(bytes)
const xml = (bytes: Uint8Array, name: string) => strFromU8(parts(bytes)[name]!)
const reopen = (bytes: Uint8Array) => openWorkbook(bytes)
const val = (bytes: Uint8Array, sheet: string, r: number, c: number) =>
  reopen(bytes).sheet(sheet).cells.get(cellKey(r, c))

describe('xlsx editor: round trip', () => {
  it('saves the original bytes when nothing changed', () => {
    const bytes = budgetBook()
    expect(createSheetEditor(bytes).toBytes()).toBe(bytes)
  })

  it('edit, save, re-read: values and formulas land; formulas are recalculated and cached; untouched parts stay byte for byte', () => {
    const bytes = budgetBook()
    const ed = createSheetEditor(bytes)
    ed.apply({
      op: 'set_cells',
      sheet: 'Budget',
      cells: [
        { ref: 'B3', value: 450 },
        { ref: 'A5', value: 'Note' },
        { ref: 'B5', formula: '=B4*2' },
      ],
    })
    const out = ed.toBytes()
    const s = reopen(out).sheet('Budget')
    expect(s.cells.get(cellKey(2, 1))?.value).toBe(450)
    expect(s.cells.get(cellKey(4, 0))?.value).toBe('Note')
    expect(s.cells.get(cellKey(4, 1))).toMatchObject({ formula: 'B4*2', value: 3300 })
    // Dependants got new cached values, in this sheet and the other one.
    expect(s.cells.get(cellKey(3, 1))?.value).toBe(1650)
    expect(val(out, 'Summary', 0, 0)?.value).toBe(3300)
    // Excel recalculates on open; the stale calculation chain is gone.
    expect(xml(out, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"')
    expect(parts(out)['xl/calcChain.xml']).toBeUndefined()
    expect(xml(out, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain')
    expect(xml(out, '[Content_Types].xml')).not.toContain('calcChain')
    // Untouched parts are the same bytes.
    expect(parts(out)['xl/theme/theme1.xml']).toEqual(parts(bytes)['xl/theme/theme1.xml'])
    expect(parts(out)['xl/styles.xml']).toEqual(parts(bytes)['xl/styles.xml'])
  })

  it('keeps the format of the cells it writes and of every cell it does not', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({
      op: 'set_cells',
      sheet: 'Budget',
      cells: [
        { ref: 'B2', value: 999 },
        { ref: 'A1', value: 'Thing' },
      ],
    })
    const s = reopen(ed.toBytes()).sheet('Budget')
    expect(s.cells.get(cellKey(1, 1))).toMatchObject({ value: 999, style: 2 })
    expect(s.cells.get(cellKey(0, 0))).toMatchObject({ value: 'Thing', style: 1 })
    expect(s.cells.get(cellKey(0, 1))).toMatchObject({ value: 'Cost', style: 1 })
    expect(s.cols[0]).toMatchObject({ widthPx: 145 })
    expect(s.merges).toHaveLength(1)
  })

  it('clearing keeps the cell’s format (like Delete in Excel)', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({
      op: 'set_cells',
      sheet: 'Budget',
      cells: [
        { ref: 'B2', value: null },
        { ref: 'B3', value: null },
      ],
    })
    const s = reopen(ed.toBytes()).sheet('Budget')
    expect(s.cells.get(cellKey(1, 1))).toMatchObject({ value: null, style: 2 })
    expect(s.cells.get(cellKey(2, 1))).toBeUndefined()
    expect(s.cells.get(cellKey(3, 1))?.value).toBe(0)
  })

  it('sets number formats as a copy of the cell’s format (fill and font kept), reusing an identical one', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({ op: 'set_format', sheet: 'Budget', range: 'B2:B3', format: '0.00%' })
    const wb = reopen(ed.toBytes())
    const s = wb.sheet('Budget')
    const b2 = wb.styles().xf(s.cells.get(cellKey(1, 1))!.style)
    const b3 = wb.styles().xf(s.cells.get(cellKey(2, 1))!.style)
    expect(b2).toMatchObject({ numFmt: '0.00%', fill: '#FFFF00' })
    expect(b3).toMatchObject({ numFmt: '0.00%', fill: null })
    ed.apply({ op: 'set_format', sheet: 'Budget', range: 'C1', format: '0.00%' })
    expect(ed.wb.sheet('Budget').cells.get(cellKey(0, 2))?.style).toBe(
      ed.wb.sheet('Budget').cells.get(cellKey(2, 1))?.style,
    )
    ed.apply({ op: 'set_format', sheet: 'Budget', range: 'C2', format: 'yyyy-mm-dd' })
    expect(ed.wb.styles().xf(ed.wb.sheet('Budget').cells.get(cellKey(1, 2))!.style).numFmt).toBe(
      'yyyy-mm-dd',
    )
  })

  it('a typed date gets a date format only when the cell is General', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({ op: 'set_format', sheet: 'Budget', range: 'B3', format: '0.0%' })
    ed.apply({
      op: 'set_cells',
      sheet: 'Budget',
      cells: [
        { ref: 'C2', value: 45292, impliedFormat: 'mm-dd-yy' },
        { ref: 'B2', value: 0.5, impliedFormat: '0%' },
        { ref: 'B3', value: 0.5, impliedFormat: '0%' },
      ],
    })
    const wb = ed.wb
    const xf = (r: number, c: number) =>
      wb.styles().xf(wb.sheet('Budget').cells.get(cellKey(r, c))!.style)
    expect(xf(1, 2).numFmtId).toBe(14)
    expect(xf(1, 1)).toMatchObject({ numFmt: '0%', fill: '#FFFF00' })
    expect(xf(2, 1).numFmt).toBe('0.0%')
  })

  it('writes new text to the shared strings, new formulas with the prefix newer functions need', () => {
    const ed = createSheetEditor(buildXlsx({ sheets: [{ name: 'S' }] }))
    ed.apply({
      op: 'set_cells',
      sheet: 'S',
      cells: [
        { ref: 'A1', value: 'hi' },
        { ref: 'A2', formula: 'CONCAT(A1,"!")' },
        { ref: 'A3', value: true },
      ],
    })
    const out = ed.toBytes()
    expect(xml(out, 'xl/sharedStrings.xml')).toContain('<t>hi</t>')
    expect(xml(out, 'xl/worksheets/sheet1.xml')).toContain('_xlfn.CONCAT(A1,"!")')
    expect(val(out, 'S', 1, 0)).toMatchObject({ value: 'hi!' })
    expect(val(out, 'S', 2, 0)).toMatchObject({ value: true })
  })

  it('refuses a formula it can’t read, a cell inside a merge, and changes nothing', () => {
    const ed = createSheetEditor(budgetBook())
    expect(() =>
      ed.apply({
        op: 'set_cells',
        sheet: 'Budget',
        cells: [
          { ref: 'A1', value: 'x' },
          { ref: 'B1', formula: 'SUM(1,' },
        ],
      }),
    ).toThrow(/can't be read/)
    expect(() =>
      ed.apply({ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'F1', value: 1 }] }),
    ).toThrow(/merged cells E1:F1/)
    expect(ed.changed()).toBe(false)
    expect(ed.wb.sheet('Budget').cells.get(cellKey(0, 0))?.value).toBe('Item')
  })

  it('a formula it can’t calculate keeps Excel’s last value on save', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [{ name: 'S', rows: row(1, num('A1', 1) + fml('B1', 'WEBSERVICE(A1)', 41)) }],
      }),
    )
    ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'A1', value: 2 }] })
    expect(val(ed.toBytes(), 'S', 0, 1)).toMatchObject({ value: 41, formula: 'WEBSERVICE(A1)' })
    expect(workbookNotes(ed).find((n) => n.kind === 'formulas_kept')).toMatchObject({
      count: 1,
      detail: 'WEBSERVICE',
    })
  })

  it('undoes and redoes whole operations', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'B2', value: 1 }] })
    ed.apply({ op: 'add_sheet', name: 'Extra' })
    expect(ed.wb.sheets().map((s) => s.name)).toEqual(['Budget', 'Summary', 'Extra'])
    ed.undo()
    expect(ed.wb.sheets().map((s) => s.name)).toEqual(['Budget', 'Summary'])
    ed.undo()
    expect(ed.wb.sheet('Budget').cells.get(cellKey(1, 1))?.value).toBe(1200)
    expect(ed.canUndo()).toBe(false)
    ed.redo()
    ed.redo()
    expect(ed.wb.sheet('Budget').cells.get(cellKey(1, 1))?.value).toBe(1)
    expect(
      reopen(ed.toBytes())
        .sheets()
        .map((s) => s.name),
    ).toEqual(['Budget', 'Summary', 'Extra'])
  })
})

describe('xlsx editor: sheets', () => {
  it('adds a sheet that Excel can open (part, relationship, content type, unique id)', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({ op: 'add_sheet', name: 'Q1 plan' })
    ed.apply({ op: 'set_cells', sheet: 'Q1 plan', cells: [{ ref: 'A1', formula: 'Budget!B4+1' }] })
    const out = ed.toBytes()
    expect(xml(out, '[Content_Types].xml')).toContain('/xl/worksheets/sheet3.xml')
    expect(xml(out, 'xl/workbook.xml')).toMatch(
      /<sheet name="Q1 plan" sheetId="3" r:id="rId\d+"\/>/,
    )
    expect(val(out, 'Q1 plan', 0, 0)).toMatchObject({ value: 1501 })
  })

  it('refuses sheet names Excel refuses', () => {
    const ed = createSheetEditor(budgetBook())
    expect(() => ed.apply({ op: 'add_sheet', name: 'budget' })).toThrow(
      /already a sheet called “Budget”/,
    )
    expect(() => ed.apply({ op: 'add_sheet', name: 'a/b' })).toThrow(/can't contain/)
    expect(() => ed.apply({ op: 'add_sheet', name: 'x'.repeat(32) })).toThrow(/31 characters/)
  })

  it('renames a sheet and every formula and name that uses it', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({ op: 'rename_sheet', sheet: 'Budget', name: 'Money 2026' })
    const out = ed.toBytes()
    const wb = reopen(out)
    expect(wb.sheets().map((s) => s.name)).toEqual(['Money 2026', 'Summary'])
    expect(wb.sheet('Summary').cells.get(cellKey(0, 0))?.formula).toBe("'Money 2026'!B4*2")
    expect(wb.sheet('Summary').cells.get(cellKey(0, 1))?.formula).toBe("'Money 2026'!C4")
    expect(wb.definedNames()[0]!.formula).toBe("'Money 2026'!$B$2:$B$3")
    expect(wb.sheet('Summary').cells.get(cellKey(0, 0))?.value).toBe(3000)
  })

  it('deletes a sheet: formulas that used it read #REF!, its part goes, the last sheet stays', () => {
    const ed = createSheetEditor(budgetBook())
    expect(ed.losses({ op: 'delete_sheet', sheet: 'Budget' })).toEqual([
      { feature: 'formulas_ref_error', count: 2 },
      { feature: 'names_ref_error', count: 1 },
    ])
    expect(() => ed.apply({ op: 'delete_sheet', sheet: 'Budget' })).toThrow(XlsxLossError)
    ed.apply({ op: 'delete_sheet', sheet: 'Budget' }, { acceptLosses: true })
    const out = ed.toBytes()
    const wb = reopen(out)
    expect(wb.sheets().map((s) => s.name)).toEqual(['Summary'])
    expect(wb.sheet('Summary').cells.get(cellKey(0, 0))).toMatchObject({
      formula: '#REF!*2',
      value: { error: '#REF!' },
    })
    expect(parts(out)['xl/worksheets/sheet1.xml']).toBeUndefined()
    expect(xml(out, '[Content_Types].xml')).not.toContain('sheet1.xml')
    expect(() => ed.apply({ op: 'delete_sheet', sheet: 'Summary' })).toThrow(/at least one sheet/)
  })
})

describe('xlsx editor: rows and columns', () => {
  it('inserting rows moves cells, formulas everywhere, names and merges with them', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({ op: 'insert_rows', sheet: 'Budget', at: 2, count: 2 })
    const out = ed.toBytes()
    const wb = reopen(out)
    const s = wb.sheet('Budget')
    expect(s.cells.get(cellKey(4, 0))?.value).toBe('Food')
    expect(s.cells.get(cellKey(5, 1))).toMatchObject({ formula: 'SUM(B2:B5)', value: 1500 })
    expect(wb.sheet('Summary').cells.get(cellKey(0, 0))?.formula).toBe('Budget!B6*2')
    expect(wb.definedNames()[0]!.formula).toBe('Budget!$B$2:$B$5')
    expect(s.merges).toEqual([{ top: 0, left: 4, bottom: 0, right: 5 }])
    expect(xml(out, 'xl/worksheets/sheet1.xml')).toContain('<dimension ref="A1:D6"/>')
  })

  it('deleting rows: references into them become #REF!, ranges shrink', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({ op: 'delete_rows', sheet: 'Budget', at: 1, count: 1 })
    const s = reopen(ed.toBytes()).sheet('Budget')
    expect(s.cells.get(cellKey(1, 0))?.value).toBe('Food')
    expect(s.cells.get(cellKey(2, 1))).toMatchObject({ formula: 'SUM(B2)', value: 300 })
    ed.apply({ op: 'delete_rows', sheet: 'Budget', at: 2, count: 1 })
    expect(ed.wb.sheet('Summary').cells.get(cellKey(0, 0))?.formula).toBe('Budget!#REF!*2')
  })

  it('inserting and deleting columns moves cells, column widths and formulas', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({ op: 'insert_columns', sheet: 'Budget', at: 1, count: 1 })
    let s = ed.wb.sheet('Budget')
    expect(s.cells.get(cellKey(1, 2))?.value).toBe(1200)
    expect(s.cells.get(cellKey(3, 2))?.formula).toBe('SUM(C2:C3)')
    expect(s.cols.map((c) => [c.min, c.max])).toEqual([
      [0, 0],
      [3, 4],
    ])
    expect(s.merges).toEqual([{ top: 0, left: 5, bottom: 0, right: 6 }])
    ed.apply({ op: 'delete_columns', sheet: 'Budget', at: 0, count: 2 })
    s = ed.wb.sheet('Budget')
    expect(s.cells.get(cellKey(1, 0))?.value).toBe(1200)
    expect(ed.wb.sheet('Summary').cells.get(cellKey(0, 0))?.formula).toBe('Budget!A4*2')
    expect(reopen(ed.toBytes()).sheet('Summary').cells.get(cellKey(0, 0))?.value).toBe(3000)
  })

  it('writes shared formulas out per cell before moving them', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows:
              row(
                1,
                num('A1', 1) + '<c r="B1"><f t="shared" ref="B1:B2" si="0">A1*2</f><v>2</v></c>',
              ) + row(2, num('A2', 2) + '<c r="B2"><f t="shared" si="0"/><v>4</v></c>'),
          },
        ],
      }),
    )
    ed.apply({ op: 'insert_rows', sheet: 'S', at: 1, count: 1 })
    const s = reopen(ed.toBytes()).sheet('S')
    expect(s.cells.get(cellKey(0, 1))).toMatchObject({
      formula: 'A1*2',
      formulaType: 'normal',
      value: 2,
    })
    expect(s.cells.get(cellKey(2, 1))).toMatchObject({
      formula: 'A3*2',
      formulaType: 'normal',
      value: 4,
    })
  })

  it('names what would end up wrong (tables, pictures, comments) and does it only when accepted', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: row(1, num('A1', 1)),
          after:
            '<drawing r:id="rId1"/><tableParts count="1"><tablePart r:id="rId2"/></tableParts>',
          rels: [
            { id: 'rId1', type: 'drawing', target: '../drawings/drawing1.xml' },
            { id: 'rId2', type: 'table', target: '../tables/table1.xml' },
          ],
        },
      ],
      parts: {
        '/xl/drawings/drawing1.xml': {
          xml: '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>',
          type: 'application/vnd.openxmlformats-officedocument.drawing+xml',
        },
        '/xl/tables/table1.xml': {
          xml: '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" displayName="T" ref="A1:A2"/>',
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml',
        },
      },
    })
    const ed = createSheetEditor(bytes)
    const op = { op: 'insert_rows', sheet: 'S', at: 0, count: 1 } as const
    expect(ed.losses(op)).toEqual([
      { feature: 'tables', count: 1 },
      { feature: 'drawings', count: 1 },
    ])
    expect(() => ed.apply(op)).toThrow(XlsxLossError)
    expect(ed.changed()).toBe(false)
    ed.apply(op, { acceptLosses: true })
    const out = ed.toBytes()
    expect(val(out, 'S', 1, 0)?.value).toBe(1)
    expect(parts(out)['xl/tables/table1.xml']).toEqual(parts(bytes)['xl/tables/table1.xml'])
  })
})
