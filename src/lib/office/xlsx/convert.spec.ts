import { describe, expect, it } from 'vitest'
import { extractOfficeText } from '../text'
import { CONVERSION_NOT_KEPT, convertToXlsx, xlsxCopyName } from './convert'
import { createSheetEditor } from './editor'
import { sheetValues } from './read'
import { cellKey } from './ref'
import { odsBook, xlsBook } from './test-utils/legacy-fixtures'

describe('.xls and .ods: shown through a conversion to .xlsx', () => {
  it('an OpenDocument spreadsheet converts: sheets, values, a formula in Excel syntax, a hidden sheet', async () => {
    const { bytes, notKept } = await convertToXlsx('ods', odsBook())
    expect(notKept).toEqual(CONVERSION_NOT_KEPT.ods)
    const ed = createSheetEditor(bytes)
    expect(ed.wb.sheets().map((s) => [s.name, s.state])).toEqual([
      ['Budget', 'visible'],
      ['Archive', 'hidden'],
    ])
    expect(sheetValues(ed, 'Budget', null, 'en').rows).toEqual([
      ['Item', 'Cost'],
      ['Rent', '1200'],
      ['Food', '450'],
      ['Total', '1650'],
    ])
    expect(ed.wb.sheet('Budget').cells.get(cellKey(3, 1))).toMatchObject({ formula: 'SUM(B2:B3)' })
    expect(sheetValues(ed, 'Archive', null, 'en').rows).toEqual([['Old']])
  })

  it('an Excel 97–2003 workbook (BIFF8) converts: values, text, formulas, sheets', async () => {
    const { bytes, notKept } = await convertToXlsx('xls', await xlsBook())
    expect(notKept).toContain('cell_styles')
    expect(notKept).toContain('macros')
    const ed = createSheetEditor(bytes)
    expect(ed.wb.sheets().map((s) => s.name)).toEqual(['Budget', 'Notes'])
    expect(ed.wb.sheet('Budget').cells.get(cellKey(3, 1))).toMatchObject({ formula: 'SUM(B2:B3)' })
    expect(sheetValues(ed, 'Budget', null, 'en').rows).toEqual([
      ['Item', 'Cost'],
      ['Rent', '1200'],
      ['Food', '450'],
      ['Total', '1650'],
    ])
    expect(sheetValues(ed, 'Notes', null, 'en').rows).toEqual([['Paid in March']])
  })

  it('the converted copy is a normal workbook: it edits and saves', async () => {
    const ed = createSheetEditor((await convertToXlsx('ods', odsBook())).bytes)
    ed.apply({ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'B3', value: 500 }] })
    const again = createSheetEditor(ed.toBytes())
    expect(again.wb.sheet('Budget').cells.get(cellKey(3, 1))?.value).toBe(1700)
  })

  it('refuses what is not of the format, with the reason', async () => {
    await expect(convertToXlsx('xls', new TextEncoder().encode('hello'))).rejects.toThrow(
      /not a Compound File/,
    )
    await expect(convertToXlsx('ods', new TextEncoder().encode('hello'))).rejects.toThrow(
      /not a ZIP package/,
    )
  })

  it('drive.read gives them as Markdown tables, like .xlsx', async () => {
    const ods = await extractOfficeText('ods', odsBook())
    expect(ods).toContain('## Sheet: Budget')
    expect(ods).toContain('| Total | 1650 |')
    expect(ods).toContain('## Sheet: Archive (hidden)')
    const xls = await extractOfficeText('xls', await xlsBook())
    expect(xls).toContain('| Rent | 1200 |')
    expect(xls).toContain('## Sheet: Notes')
  })

  it('names the copy after the original', () => {
    expect(xlsxCopyName('budget.xls')).toBe('budget.xlsx')
    expect(xlsxCopyName('Q3 plan.ODS')).toBe('Q3 plan.xlsx')
  })
})
