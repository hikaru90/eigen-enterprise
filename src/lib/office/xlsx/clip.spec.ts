import { describe, expect, it } from 'vitest'
import { foreignClip, readClip } from './clip'
import { clipFromClipboard, clipFromHtml, clipFromTsv, clipToHtml, clipToTsv } from './clip-interop'
import { createSheetEditor } from './editor'
import { cellKey, requireRange } from './ref'
import { budgetBook, buildXlsx, fml, num, row, str } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

const book = () =>
  buildXlsx({
    strings: ['Item', 'Q1', 'Q2', 'Rent', 'Food'],
    sheets: [
      {
        name: 'Data',
        rows:
          row(1, str('A1', 0, 1) + str('B1', 1, 1) + str('C1', 2, 1)) +
          row(2, str('A2', 3) + num('B2', 100, 2) + fml('C2', 'B2*2+$B$2', 300, 3)) +
          row(3, str('A3', 4) + num('B3', 200) + fml('C3', 'B3*2', 400)),
        after: '<mergeCells count="1"><mergeCell ref="E1:F1"/></mergeCells>',
      },
      {
        name: 'Other',
        rows: row(1, fml('A1', 'Data!B2+Data!C2', 400)) + row(2, num('A2', 5)),
      },
    ],
  })

describe('clipboard copy, cut, paste & paste special', () => {
  it('copies and pastes values, formulas with relative-ref shift, and formats within a sheet', () => {
    const ed = createSheetEditor(book())
    const clip = readClip(ed, 'Data', requireRange('A2:C3'), 'book-1')
    ed.apply({ op: 'paste', sheet: 'Data', at: 'A5', clip })
    const wb = openWorkbook(ed.toBytes())
    const s = wb.sheet('Data')
    expect(s.cells.get(cellKey(4, 0))?.value).toBe('Rent')
    expect(s.cells.get(cellKey(4, 1))?.value).toBe(100)
    expect(wb.styles().xf(s.cells.get(cellKey(4, 1))!.style).fill).toBe('#FFFF00')
    expect(s.cells.get(cellKey(4, 2))).toMatchObject({ formula: 'B5*2+$B$2', value: 300 })
    expect(s.cells.get(cellKey(5, 2))).toMatchObject({ formula: 'B6*2', value: 400 })
    // Tiling a 1x3 block onto 2x6 tiles cleanly
    const rowClip = readClip(ed, 'Data', requireRange('A2:C2'), 'book-1')
    ed.apply({ op: 'paste', sheet: 'Data', at: 'A8:F9', clip: rowClip })
    const s2 = ed.wb.sheet('Data')
    expect(s2.cells.get(cellKey(7, 3))?.value).toBe('Rent')
    expect(s2.cells.get(cellKey(8, 4))?.value).toBe(100)
  })

  it('copies and pastes between sheets and between workbooks (foreignClip carries look, not xf index)', () => {
    const ed1 = createSheetEditor(book())
    const clip = readClip(ed1, 'Data', requireRange('A2:C2'), 'book-1')
    ed1.apply({ op: 'paste', sheet: 'Other', at: 'B3', clip })
    const o1 = ed1.wb.sheet('Other')
    expect(o1.cells.get(cellKey(2, 3))).toMatchObject({ formula: 'C3*2+$B$2' })
    expect(ed1.wb.styles().xf(o1.cells.get(cellKey(2, 2))!.style).fill).toBe('#FFFF00')

    // Another workbook receives foreignClip
    const ed2 = createSheetEditor(budgetBook())
    ed2.apply({ op: 'paste', sheet: 'Budget', at: 'E3', clip: foreignClip(clip) })
    const b2 = ed2.wb.sheet('Budget')
    expect(b2.cells.get(cellKey(2, 4))?.value).toBe('Rent')
    expect(ed2.wb.styles().xf(b2.cells.get(cellKey(2, 5))!.style).fill).toBe('#FFFF00')
    expect(ed2.wb.styles().xf(b2.cells.get(cellKey(2, 6))!.style).numFmt).toBe('0.0%')
  })

  it('paste special supports values, formulas, formats, transpose and skipBlanks', () => {
    const ed = createSheetEditor(book())
    const clip = readClip(ed, 'Data', requireRange('B2:C3'), 'book-1')
    // Values only keeps target style and drops formula
    ed.apply({ op: 'set_style', sheet: 'Data', range: 'E5', style: { bold: true } })
    ed.apply({ op: 'paste', sheet: 'Data', at: 'E5', clip, paste: 'values' })
    expect(ed.wb.sheet('Data').cells.get(cellKey(4, 5))).toMatchObject({
      formula: null,
      value: 300,
    })
    expect(ed.wb.styles().xf(ed.wb.sheet('Data').cells.get(cellKey(4, 4))!.style).font.bold).toBe(
      true,
    )

    // Formats only copies fill/numFmt without overwriting target text
    ed.apply({ op: 'set_cells', sheet: 'Data', cells: [{ ref: 'A10', value: 'Keep' }] })
    ed.apply({ op: 'paste', sheet: 'Data', at: 'A10', clip, paste: 'formats' })
    expect(ed.wb.sheet('Data').cells.get(cellKey(9, 0))?.value).toBe('Keep')
    expect(ed.wb.styles().xf(ed.wb.sheet('Data').cells.get(cellKey(9, 0))!.style).fill).toBe(
      '#FFFF00',
    )

    // Formulas only keeps formulas adjusted without overwriting target style
    ed.apply({ op: 'paste', sheet: 'Data', at: 'E10', clip, paste: 'formulas' })
    expect(ed.wb.sheet('Data').cells.get(cellKey(9, 5))?.formula).toBe('E10*2+$B$2')
    expect(ed.wb.styles().xf(ed.wb.sheet('Data').cells.get(cellKey(9, 4))!.style).fill).toBeNull()

    // Transpose
    const tClip = readClip(ed, 'Data', requireRange('A1:C2'), 'book-1')
    ed.apply({ op: 'paste', sheet: 'Other', at: 'A5', clip: tClip, transpose: true })
    const o = ed.wb.sheet('Other')
    expect(o.cells.get(cellKey(4, 0))?.value).toBe('Item')
    expect(o.cells.get(cellKey(5, 0))?.value).toBe('Q1')
    expect(o.cells.get(cellKey(6, 0))?.value).toBe('Q2')
    expect(o.cells.get(cellKey(5, 1))?.value).toBe(100)

    // Skip blanks preserves existing target cell where source is blank
    ed.apply({
      op: 'set_cells',
      sheet: 'Other',
      cells: [
        { ref: 'D1', value: 'X' },
        { ref: 'E1', value: null },
        { ref: 'D2', value: 'KeepMe' },
        { ref: 'E2', value: 'Old' },
      ],
    })
    const sparse = readClip(ed, 'Other', requireRange('D1:E1'), 'book-1')
    ed.apply({ op: 'paste', sheet: 'Other', at: 'D2', clip: sparse, skipBlanks: true })
    expect(ed.wb.sheet('Other').cells.get(cellKey(1, 3))?.value).toBe('X')
    expect(ed.wb.sheet('Other').cells.get(cellKey(1, 4))?.value).toBe('Old')
  })

  it('cut and paste moves cells, clears source, preserves formula targets, and updates incoming refs across sheets', () => {
    const ed = createSheetEditor(book())
    const clip = readClip(ed, 'Data', requireRange('B2:C2'), 'book-1')
    ed.apply({ op: 'paste', sheet: 'Other', at: 'B5', clip, cut: true })
    const wb = openWorkbook(ed.toBytes())
    const d = wb.sheet('Data')
    const o = wb.sheet('Other')
    // Source B2:C2 cleared
    expect(d.cells.get(cellKey(1, 1))).toBeUndefined()
    expect(d.cells.get(cellKey(1, 2))).toBeUndefined()
    // Moved formula in Other!C5 points at its moved sibling B5 (and moved $B$2 -> Other!$B$5)
    expect(o.cells.get(cellKey(4, 1))?.value).toBe(100)
    expect(o.cells.get(cellKey(4, 2))?.formula).toBe('B5*2+$B$5')
    // Other!A1 previously pointed at Data!B2+Data!C2 -> followed to B5+C5
    expect(o.cells.get(cellKey(0, 0))?.formula).toBe('B5+C5')
  })

  it('skips rows hidden by an AutoFilter when copying', () => {
    const ed = createSheetEditor(book())
    ed.apply({ op: 'set_autofilter', sheet: 'Data', range: 'A1:C3' })
    ed.apply({ op: 'filter_column', sheet: 'Data', col: 0, values: ['Food'] })
    const clip = readClip(ed, 'Data', requireRange('A1:C3'), 'book-1')
    expect(clip.rows).toBe(2)
    expect(clip.cells[0]?.[0]?.value).toBe('Item')
    expect(clip.cells[1]?.[0]?.value).toBe('Food')
  })
})

describe('clipboard interop (TSV & HTML for Excel / Google Sheets / Numbers)', () => {
  it('round-trips TSV both directions including quoted cells with tabs/newlines', () => {
    const ed = createSheetEditor(
      buildXlsx({
        strings: ['a\tb', 'line1\nline2'],
        sheets: [
          {
            name: 'S',
            rows: row(1, str('A1', 0) + num('B1', 42)) + row(2, str('A2', 1) + num('B2', 0.25, 3)),
          },
        ],
      }),
    )
    const clip = readClip(ed, 'S', requireRange('A1:B2'), 'b1')
    const tsv = clipToTsv(clip)
    expect(tsv).toBe('"a\tb"\t42\n"line1\nline2"\t25.0%')

    const parsed = clipFromTsv(tsv, 'en')!
    expect(parsed.rows).toBe(2)
    expect(parsed.cols).toBe(2)
    expect(parsed.cells[0]?.[0]?.value).toBe('a\tb')
    expect(parsed.cells[0]?.[1]?.value).toBe(42)
    expect(parsed.cells[1]?.[0]?.value).toBe('line1\nline2')
    expect(parsed.cells[1]?.[1]).toMatchObject({ value: 0.25, implied: '0.00%' })
  })

  it('exports Excel-compatible HTML with styles, formulas, merges and rich text, and parses it back', () => {
    const ed = createSheetEditor(book())
    ed.apply({
      op: 'set_rich_text',
      sheet: 'Data',
      ref: 'A5',
      runs: [
        { text: 'Hello ', bold: true },
        { text: 'World', color: '#FF0000' },
      ],
    })
    ed.apply({ op: 'merge_cells', sheet: 'Data', range: 'A5:B5', mode: 'merge' })
    const clip = readClip(ed, 'Data', requireRange('A5:C5'), 'b1')
    const html = clipToHtml(clip)
    expect(html).toContain('colspan="2"')
    expect(html).toContain('font-weight:bold')
    expect(html).toContain('#FF0000')

    const back = clipFromHtml(html, 'en')!
    expect(back.rows).toBe(1)
    expect(back.cols).toBe(3)
    expect(back.merges).toEqual([{ top: 0, left: 0, bottom: 0, right: 1 }])
    expect(back.cells[0]?.[0]?.runs).toEqual([
      { text: 'Hello ', bold: true },
      { text: 'World', color: '#FF0000' },
    ])
  })

  it('parses Google Sheets HTML (data-sheets-formula R1C1, data-sheets-value, numberformat) and Apple Numbers <style> classes', () => {
    const sheetsHtml = `<google-sheets-html-origin>
      <style type="text/css"><!--td {border: 1px solid #ccc;}--></style>
      <table><tbody>
        <tr>
          <td data-sheets-value='{"1":2,"2":"Total"}' style="font-weight:bold;background-color:#ddebf7;">Total</td>
          <td data-sheets-value='{"1":3,"3":150}' data-sheets-formula="=R[0]C[-1]" data-sheets-numberformat='{"1":2,"2":"#,##0.00","3":1}'>$150.00</td>
        </tr>
      </tbody></table>`
    const gs = clipFromClipboard({ html: sheetsHtml, text: 'Total\t150' }, 'en')!
    expect(gs.cells[0]?.[0]).toMatchObject({
      value: 'Total',
      look: { font: { bold: true }, fill: '#DDEBF7' },
    })
    expect(gs.cells[0]?.[1]).toMatchObject({
      value: 150,
      formula: 'A1',
      look: { numFmt: '#,##0.00' },
    })

    const numbersHtml = `<html><head><style>
      td.td1 { background-color: rgb(255, 255, 0); text-align: right; }
      span.s1 { font-weight: 700; font-style: italic; }
    </style></head><body><table><tbody>
      <tr><td class="td1"><p class="p1"><span class="s1">99</span></p></td></tr>
    </tbody></table></body></html>`
    const numClip = clipFromHtml(numbersHtml, 'en')!
    expect(numClip.cells[0]?.[0]).toMatchObject({
      value: 99,
      look: { fill: '#FFFF00', horizontal: 'right' },
    })
  })
})
