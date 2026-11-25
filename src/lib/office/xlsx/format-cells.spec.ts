import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { sheetSizes, styleSummary } from './format-cells'
import { cellKey } from './ref'
import { budgetBook, buildXlsx, num, row } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

const parts = (bytes: Uint8Array) => unzipSync(bytes)
const xml = (bytes: Uint8Array, name: string) => strFromU8(parts(bytes)[name]!)
const styleAt = (bytes: Uint8Array, sheet: string, r: number, c: number) => {
  const wb = openWorkbook(bytes)
  return wb.styles().xf(wb.sheet(sheet).cells.get(cellKey(r, c))?.style ?? 0)
}
const count = (text: string, tag: string) =>
  (text.match(new RegExp(`<${tag}[ >/]`, 'g')) ?? []).length

describe('cell formatting (fonts, fills, borders, alignment)', () => {
  it('bolds a range as a copy of each cell’s format: fill, number format and other cells stay; untouched parts byte for byte', () => {
    const bytes = budgetBook()
    const ed = createSheetEditor(bytes)
    // B2 has the yellow fill (xf 2), B3 is plain.
    ed.apply({ op: 'set_style', sheet: 'Budget', range: 'B2:B3', style: { bold: true } })
    const out = ed.toBytes()
    const b2 = styleAt(out, 'Budget', 1, 1)
    expect(b2.font.bold).toBe(true)
    expect(b2.fill).toBe('#FFFF00')
    expect(styleAt(out, 'Budget', 2, 1).font).toMatchObject({ bold: true, sizePt: 11 })
    // Not formatted: still as they were.
    expect(styleAt(out, 'Budget', 1, 0).font.bold).toBe(false)
    expect(openWorkbook(out).sheet('Budget').cells.get(cellKey(1, 0))?.style ?? 0).toBe(0)
    for (const p of ['xl/theme/theme1.xml', 'xl/worksheets/sheet2.xml', 'xl/sharedStrings.xml'])
      expect(parts(out)[p]).toEqual(parts(bytes)[p])
    // The original records are all still there, in place.
    const styles = xml(out, 'xl/styles.xml')
    expect(styles).toContain('<numFmt numFmtId="164" formatCode="0.0%"/>')
    expect(styles).toMatch(/<cellXfs count="7">/)
  })

  it('reuses identical records instead of adding new ones', () => {
    const ed = createSheetEditor(budgetBook())
    // A plain cell made bold: font 1 is bold but red, so a new bold font is written once.
    ed.apply({ op: 'set_style', sheet: 'Budget', range: 'B3', style: { bold: true } })
    ed.apply({ op: 'set_style', sheet: 'Budget', range: 'A3', style: { bold: true } })
    const s1 = xml(ed.toBytes(), 'xl/styles.xml')
    expect(count(s1, 'font')).toBe(3)
    expect(s1).toMatch(/<cellXfs count="6">/)
    const wb = openWorkbook(ed.toBytes())
    const st = (r: number, c: number) => wb.sheet('Budget').cells.get(cellKey(r, c))!.style
    expect(st(2, 1)).toBe(st(2, 0))
    // Bold twice changes nothing; un-bolding goes back to the plain record.
    ed.apply({ op: 'set_style', sheet: 'Budget', range: 'B3', style: { bold: true } })
    ed.apply({ op: 'set_style', sheet: 'Budget', range: 'A3', style: { bold: false } })
    const wb2 = openWorkbook(ed.toBytes())
    expect(wb2.sheet('Budget').cells.get(cellKey(2, 0))!.style).toBe(0)
    expect(count(xml(ed.toBytes(), 'xl/styles.xml'), 'font')).toBe(3)
  })

  it('writes italic, underline, strike, size, colour and font family; a named font drops the theme font', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [{ name: 'S', rows: row(1, num('A1', 1)) }],
      }),
    )
    ed.apply({
      op: 'set_style',
      sheet: 'S',
      range: 'A1:B2',
      style: {
        italic: true,
        underline: true,
        strike: true,
        fontSize: 14,
        fontColor: '#1f4e79',
        fontName: 'Arial',
      },
    })
    const out = ed.toBytes()
    expect(styleAt(out, 'S', 1, 1).font).toEqual({
      bold: false,
      italic: true,
      underline: true,
      strike: true,
      color: '#1F4E79',
      sizePt: 14,
      name: 'Arial',
    })
    expect(xml(out, 'xl/styles.xml')).toContain(
      '<font><i/><strike/><u/><sz val="14"/><color rgb="FF1F4E79"/><name val="Arial"/></font>',
    )
    // Empty cells in the range were made to carry the format.
    expect(openWorkbook(out).sheet('S').cells.get(cellKey(1, 1))?.style).toBeGreaterThan(0)
    ed.apply({ op: 'set_style', sheet: 'S', range: 'A1', style: { fontColor: null } })
    expect(styleAt(ed.toBytes(), 'S', 0, 0).font.color).toBeNull()
  })

  it('fills and clears the background, aligns and wraps', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({
      op: 'set_style',
      sheet: 'Budget',
      range: 'A2',
      style: { fill: '#DDEBF7', horizontal: 'center', vertical: 'top', wrap: true },
    })
    let st = styleAt(ed.toBytes(), 'Budget', 1, 0)
    expect(st).toMatchObject({
      fill: '#DDEBF7',
      horizontal: 'center',
      vertical: 'top',
      wrap: true,
    })
    expect(xml(ed.toBytes(), 'xl/styles.xml')).toContain(
      '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>',
    )
    ed.apply({
      op: 'set_style',
      sheet: 'Budget',
      range: 'A2:B2',
      style: { fill: null, horizontal: 'general', vertical: 'bottom', wrap: false },
    })
    st = styleAt(ed.toBytes(), 'Budget', 1, 0)
    expect(st).toMatchObject({ fill: null, horizontal: null, vertical: null, wrap: false })
    // B2's yellow went too; its other format stayed plain.
    expect(styleAt(ed.toBytes(), 'Budget', 1, 1).fill).toBeNull()
    expect(openWorkbook(ed.toBytes()).sheet('Budget').cells.get(cellKey(1, 0))?.style ?? 0).toBe(0)
  })

  it('border presets: all, outer, inner, one side, none — with style and colour', () => {
    const ed = createSheetEditor(buildXlsx({ sheets: [{ name: 'S' }] }))
    const edge = (r: number, c: number) => styleAt(ed.toBytes(), 'S', r, c).border
    ed.apply({
      op: 'set_style',
      sheet: 'S',
      range: 'A1:C3',
      style: { border: { preset: 'outer', style: 'medium', color: '#C00000' } },
    })
    const line = { style: 'medium', color: '#C00000' }
    expect(edge(0, 0)).toEqual({ left: line, top: line, right: null, bottom: null })
    expect(edge(1, 1)).toEqual({ left: null, top: null, right: null, bottom: null })
    expect(edge(2, 2)).toEqual({ left: null, top: null, right: line, bottom: line })
    ed.apply({
      op: 'set_style',
      sheet: 'S',
      range: 'A1:C3',
      style: { border: { preset: 'inner' } },
    })
    const thin = { style: 'thin', color: null }
    // Inner lines added, the outer ones kept.
    expect(edge(0, 0)).toEqual({ left: line, top: line, right: thin, bottom: thin })
    expect(edge(1, 1)).toEqual({ left: thin, top: thin, right: thin, bottom: thin })
    ed.apply({
      op: 'set_style',
      sheet: 'S',
      range: 'B2',
      style: { border: { preset: 'bottom', style: 'double' } },
    })
    expect(edge(1, 1).bottom).toEqual({ style: 'double', color: null })
    ed.apply({ op: 'set_style', sheet: 'S', range: 'A1:C3', style: { border: { preset: 'none' } } })
    for (const [r, c] of [
      [0, 0],
      [1, 1],
      [2, 2],
    ] as const)
      expect(edge(r, c)).toEqual({ left: null, top: null, right: null, bottom: null })
    ed.apply({ op: 'set_style', sheet: 'S', range: 'A1:B1', style: { border: { preset: 'all' } } })
    expect(edge(0, 1)).toEqual({ left: thin, top: thin, right: thin, bottom: thin })
  })

  it('a workbook without a styles part gets one', () => {
    const ed = createSheetEditor(buildXlsx({ noStyles: true, sheets: [{ name: 'S' }] }))
    ed.apply({ op: 'set_style', sheet: 'S', range: 'A1', style: { bold: true, fill: '#00FF00' } })
    expect(styleAt(ed.toBytes(), 'S', 0, 0)).toMatchObject({
      font: { bold: true },
      fill: '#00FF00',
    })
  })

  it('refuses what it can’t write, and changes nothing', () => {
    const bytes = budgetBook()
    const ed = createSheetEditor(bytes)
    const bad = [
      { fontColor: 'red' },
      { fill: '#12' },
      { fontSize: 0 },
      { fontName: '' },
      {},
      { border: { preset: 'diagonal' as never } },
      { border: { preset: 'all' as const, style: 'wavy' as never } },
    ]
    for (const style of bad)
      expect(() => ed.apply({ op: 'set_style', sheet: 'Budget', range: 'A1', style })).toThrow()
    expect(() =>
      ed.apply({ op: 'set_style', sheet: 'Budget', range: 'A1:Z5000', style: { bold: true } }),
    ).toThrow(/at most/)
    expect(ed.canUndo()).toBe(false)
    expect(ed.toBytes()).toBe(bytes)
  })

  it('undo puts the styles part and the sheet back', () => {
    const bytes = budgetBook()
    const ed = createSheetEditor(bytes)
    ed.apply({ op: 'set_style', sheet: 'Budget', range: 'A1:B4', style: { italic: true } })
    ed.undo()
    const out = ed.toBytes()
    expect(styleAt(out, 'Budget', 2, 1).font.italic).toBe(false)
    expect(xml(out, 'xl/styles.xml')).toBe(xml(bytes, 'xl/styles.xml'))
  })
})

describe('column widths and row heights', () => {
  it('sets a width: an existing entry is split, the rest keep theirs; untouched parts byte for byte', () => {
    const bytes = budgetBook()
    const ed = createSheetEditor(bytes)
    // Budget has A (20) and C:D (12).
    ed.apply({ op: 'set_column_width', sheet: 'Budget', from: 3, to: 4, width: 30 })
    const out = ed.toBytes()
    expect(xml(out, 'xl/worksheets/sheet1.xml')).toContain(
      '<cols><col min="1" max="1" width="20" customWidth="1"/><col min="3" max="3" width="12" customWidth="1"/><col min="4" max="4" width="30" customWidth="1"/><col min="5" max="5" width="30" customWidth="1"/></cols>',
    )
    const s = openWorkbook(out).sheet('Budget')
    expect(s.cols.find((c) => c.min === 3)?.widthPx).toBe(215)
    expect(parts(out)['xl/styles.xml']).toEqual(parts(bytes)['xl/styles.xml'])
    expect(parts(out)['xl/worksheets/sheet2.xml']).toEqual(parts(bytes)['xl/worksheets/sheet2.xml'])
  })

  it('makes the cols element where the schema wants it, and resets to the default', () => {
    const ed = createSheetEditor(buildXlsx({ sheets: [{ name: 'S', rows: row(1, num('A1', 1)) }] }))
    ed.apply({ op: 'set_column_width', sheet: 'S', from: 1, to: 1, width: 15.5 })
    const sheet = xml(ed.toBytes(), 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain(
      '<sheetFormatPr defaultRowHeight="15"/><cols><col min="2" max="2" width="15.5" customWidth="1"/></cols><sheetData>',
    )
    ed.apply({ op: 'set_column_width', sheet: 'S', from: 0, to: 5, width: null })
    expect(xml(ed.toBytes(), 'xl/worksheets/sheet1.xml')).not.toContain('<cols')
  })

  it('a reset keeps a column’s own format and shows it at the default width', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            before: '<cols><col min="2" max="4" width="30" style="1" customWidth="1"/></cols>',
          },
        ],
      }),
    )
    ed.apply({ op: 'set_column_width', sheet: 'S', from: 2, to: 2, width: null })
    expect(xml(ed.toBytes(), 'xl/worksheets/sheet1.xml')).toContain(
      '<col min="2" max="2" width="30" style="1" customWidth="1"/><col min="3" max="3" width="8.7109375" style="1"/><col min="4" max="4" width="30" style="1" customWidth="1"/>',
    )
  })

  it('sets and resets row heights (rows are made when missing, dropped when nothing is left)', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({ op: 'set_row_height', sheet: 'Budget', from: 1, to: 2, height: 30 })
    ed.apply({ op: 'set_row_height', sheet: 'Budget', from: 9, to: 9, height: 42.75 })
    let s = openWorkbook(ed.toBytes()).sheet('Budget')
    expect(s.rows.get(1)?.heightPx).toBe(40)
    expect(s.rows.get(9)?.heightPx).toBe(57)
    expect(xml(ed.toBytes(), 'xl/worksheets/sheet1.xml')).toContain(
      '<row r="10" ht="42.75" customHeight="1"/>',
    )
    ed.apply({ op: 'set_row_height', sheet: 'Budget', from: 0, to: 20, height: null })
    s = openWorkbook(ed.toBytes()).sheet('Budget')
    expect(s.rows.size).toBe(0)
    expect(xml(ed.toBytes(), 'xl/worksheets/sheet1.xml')).not.toContain('r="10"')
    expect(s.cells.get(cellKey(1, 1))?.value).toBe(1200)
  })

  it('refuses sizes Excel can’t hold', () => {
    const ed = createSheetEditor(budgetBook())
    expect(() =>
      ed.apply({ op: 'set_column_width', sheet: 'Budget', from: 0, to: 0, width: 300 }),
    ).toThrow(/255/)
    expect(() =>
      ed.apply({ op: 'set_row_height', sheet: 'Budget', from: 0, to: 0, height: 500 }),
    ).toThrow(/409/)
    expect(() =>
      ed.apply({ op: 'set_column_width', sheet: 'Budget', from: 3, to: 1, width: 10 }),
    ).toThrow()
    expect(ed.canUndo()).toBe(false)
  })
})

describe('reading the look back (drive.sheet_read)', () => {
  it('summarises only what differs from the plain format, and the sheet’s own sizes', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({
      op: 'set_style',
      sheet: 'Budget',
      range: 'B2',
      style: { italic: true, border: { preset: 'bottom', color: '#000000' }, horizontal: 'right' },
    })
    ed.apply({ op: 'set_row_height', sheet: 'Budget', from: 1, to: 1, height: 24 })
    const wb = ed.wb
    const st = wb.styles()
    const data = wb.sheet('Budget')
    expect(styleSummary(st.xf(data.cells.get(cellKey(1, 1))!.style), st.xf(0))).toEqual({
      italic: true,
      fill: '#FFFF00',
      horizontal: 'right',
      border: { bottom: 'thin #000000' },
    })
    expect(styleSummary(st.xf(0), st.xf(0))).toBeNull()
    expect(sheetSizes(wb, data, null)).toEqual({
      columns: [
        { columns: 'A', width: 20 },
        { columns: 'C:D', width: 12 },
      ],
      rows: [{ row: 2, height: 24 }],
    })
    expect(sheetSizes(wb, data, { top: 0, left: 1, bottom: 0, right: 1 })).toEqual({
      columns: [],
      rows: [],
    })
  })
})
