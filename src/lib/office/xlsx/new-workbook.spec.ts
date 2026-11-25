import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { readPackage, REL_OFFICE_DOCUMENT } from '../ooxml/package'
import { createSheetEditor, workbookNotes } from './editor'
import { NEW_SHEET_NAME, newWorkbookBytes } from './new-workbook'
import { sheetValues } from './read'
import { cellKey } from './ref'
import { budgetBook } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

const CT = {
  main: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  macroMain: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  sheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  styles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  vba: 'application/vnd.ms-office.vbaProject',
}

describe('a new spreadsheet (Drive → New → Spreadsheet)', () => {
  it('is a valid package: every part typed, the relationships resolve, one visible sheet', () => {
    const pkg = readPackage(newWorkbookBytes())
    const main = pkg.mainPart(REL_OFFICE_DOCUMENT)
    expect(main).toBe('/xl/workbook.xml')
    expect(pkg.contentType(main)).toBe(CT.main)
    for (const part of pkg.partNames()) expect(pkg.contentType(part)).not.toBe('')
    for (const rel of pkg.relationships(main)) expect(pkg.has(rel.part!)).toBe(true)
    expect(pkg.contentType('/xl/worksheets/sheet1.xml')).toBe(CT.sheet)
    expect(pkg.contentType('/xl/styles.xml')).toBe(CT.styles)
    // Excel's schema order and the default cell format every unstyled cell uses.
    const styles = pkg.text('/xl/styles.xml')
    expect(styles).toMatch(
      /<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"\/>/,
    )
    expect(styles.indexOf('<fonts')).toBeLessThan(styles.indexOf('<fills'))
    expect(styles.indexOf('<fills')).toBeLessThan(styles.indexOf('<borders'))
    const wb = openWorkbook(newWorkbookBytes())
    expect(wb.sheets()).toEqual([
      expect.objectContaining({ name: NEW_SHEET_NAME, kind: 'worksheet', state: 'visible' }),
    ])
    expect(workbookNotes(createSheetEditor(newWorkbookBytes()))).toEqual([])
  })

  it('round-trips through our reader: values, text and formulas written, saved and read back', () => {
    const ed = createSheetEditor(newWorkbookBytes())
    ed.apply({
      op: 'set_cells',
      sheet: NEW_SHEET_NAME,
      cells: [
        { ref: 'A1', value: 'Item' },
        { ref: 'B1', value: 40 },
        { ref: 'B2', value: 2 },
        { ref: 'B3', formula: '=B1+B2' },
        { ref: 'C1', value: 0.25, format: '0%' },
      ],
    })
    ed.apply({ op: 'add_sheet', name: 'Notes' })
    const again = createSheetEditor(ed.toBytes())
    const s = again.wb.sheet(NEW_SHEET_NAME)
    expect(s.cells.get(cellKey(2, 1))).toMatchObject({ formula: 'B1+B2', value: 42 })
    expect(sheetValues(again, NEW_SHEET_NAME, null, 'en').rows).toEqual([
      ['Item', '40', '25%'],
      ['', '2', ''],
      ['', '42', ''],
    ])
    expect(again.wb.sheets().map((x) => x.name)).toEqual([NEW_SHEET_NAME, 'Notes'])
  })

  it('is also read by an independent reader (SheetJS) as one empty sheet', async () => {
    const XLSX = await import('xlsx')
    const book = XLSX.read(newWorkbookBytes(), { type: 'array' })
    expect(book.SheetNames).toEqual([NEW_SHEET_NAME])
    expect(XLSX.utils.sheet_to_json(book.Sheets[NEW_SHEET_NAME]!, { header: 1 })).toEqual([])
  })
})

/** budgetBook as a macro-enabled workbook: the macro main content type, a VBA project part and its relationship. */
function macroBook(): { bytes: Uint8Array; vba: Uint8Array } {
  const files = unzipSync(budgetBook())
  const vba = new Uint8Array(4096).map((_, i) => (i * 37 + 11) % 256)
  files['[Content_Types].xml'] = strToU8(
    strFromU8(files['[Content_Types].xml']!)
      .replace(CT.main, CT.macroMain)
      .replace('</Types>', `<Default Extension="bin" ContentType="${CT.vba}"/></Types>`),
  )
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    strFromU8(files['xl/_rels/workbook.xml.rels']!).replace(
      '</Relationships>',
      '<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
    ),
  )
  files['xl/vbaProject.bin'] = vba
  return { bytes: zipSync(files), vba }
}

describe('a macro-enabled workbook (.xlsm)', () => {
  it('opens and edits like .xlsx; the VBA project and the macro content type stay byte for byte', () => {
    const { bytes, vba } = macroBook()
    const ed = createSheetEditor(bytes)
    expect(workbookNotes(ed)).toContainEqual({ kind: 'macros', count: 1 })
    ed.apply({ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'B3', value: 451 }] })
    ed.apply({ op: 'add_sheet', name: 'Q2' })
    const out = ed.toBytes()
    const pkg = readPackage(out)
    expect(pkg.bytes('/xl/vbaProject.bin')).toEqual(vba)
    expect(pkg.contentType('/xl/vbaProject.bin')).toBe(CT.vba)
    expect(pkg.contentType('/xl/workbook.xml')).toBe(CT.macroMain)
    expect(pkg.relationships('/xl/workbook.xml').some((r) => r.target === 'vbaProject.bin')).toBe(
      true,
    )
    expect(createSheetEditor(out).wb.sheet('Budget').cells.get(cellKey(2, 1))?.value).toBe(451)
  })

  it('a workbook without a VBA project has no macro note', () => {
    expect(workbookNotes(createSheetEditor(budgetBook())).map((n) => n.kind)).not.toContain(
      'macros',
    )
  })
})
