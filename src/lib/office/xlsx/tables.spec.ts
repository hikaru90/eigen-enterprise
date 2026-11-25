import { describe, expect, it } from 'vitest'
import { createCalc } from './calc'
import { createSheetEditor, workbookNotes } from './editor'
import { autoFilterOf, columnChoices, sheetFilters } from './filter'
import { sheetSummaries } from './read'
import { cellKey, rangeName } from './ref'
import { sortLosses } from './sort'
import { findTable, readSheetTables, tableCellLook } from './tables'
import { buildXlsx, fml, num, row, str } from './test-utils/build-xlsx'
import { openWorkbook, XlsxError } from './workbook'
import { kids } from './xml'

function salesBook(extraAfter = '') {
  return buildXlsx({
    strings: ['Item', 'Qty', 'Price', 'Total', 'Apple', 'Banana', 'Cherry', 'Note', 'TotalLabel'],
    sheets: [
      {
        name: 'Sales',
        rows:
          row(1, str('A1', 0) + str('B1', 1) + str('C1', 2) + str('D1', 3)) +
          row(2, str('A2', 4) + num('B2', 10) + num('C2', 2.5) + fml('D2', 'B2*C2', 25)) +
          row(3, str('A3', 5) + num('B3', 5) + num('C3', 4) + fml('D3', 'B3*C3', 20)) +
          row(4, str('A4', 6) + num('B4', 8) + num('C4', 3) + fml('D4', 'B4*C4', 24)),
        after: extraAfter,
      },
    ],
  })
}

function sheetXml(bytes: Uint8Array, name = 'Sales'): string {
  const wb = openWorkbook(bytes)
  return wb.pkg.text(wb.requireWorksheet(name).part)
}

function tableXml(bytes: Uint8Array, sheet = 'Sales', table = 'Table1'): string {
  const wb = openWorkbook(bytes)
  const t = findTable(wb, sheet, table)
  return wb.pkg.text(t.part)
}

describe('Excel tables', () => {
  it('creates a table from a single cell via currentRegion with header dedup, built-in style, AutoFilter, and OOXML parts', () => {
    const ed = createSheetEditor(salesBook())
    const res = ed.apply({ op: 'create_table', sheet: 'Sales', range: 'B2' })
    expect(res).toEqual({ sheets: ['Sales'] })

    const out = ed.toBytes()
    const wb = openWorkbook(out)
    const tables = readSheetTables(wb, 'Sales')
    expect(tables).toHaveLength(1)
    const t = tables[0]!
    expect(t.displayName).toBe('Table1')
    expect(rangeName(t.ref)).toBe('A1:D4')
    expect(t.headerRowCount).toBe(1)
    expect(t.totalsRowCount).toBe(0)
    expect(t.style.name).toBe('TableStyleMedium2')
    expect(t.autoFilter?.range).toEqual({ top: 0, left: 0, bottom: 3, right: 3 })
    expect(t.columns.map((c) => c.name)).toEqual(['Item', 'Qty', 'Price', 'Total'])

    // Worksheet has tableParts & valid relationship + Content_Types override
    const ws = wb.requireWorksheet('Sales')
    expect(sheetXml(out)).toContain('<tableParts count="1"><tablePart r:id="')
    const rels = wb.pkg.relationships(ws.part).filter((r) => r.type.endsWith('/table'))
    expect(rels).toHaveLength(1)
    expect(wb.pkg.contentType(rels[0]!.part!)).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml',
    )
    expect(wb.definedNames()).toEqual([]) // table filter lives in table.xml, not sheet _FilterDatabase
    expect(autoFilterOf(wb, 'Sales')).toBeNull()
    expect(sheetFilters(wb, 'Sales')).toHaveLength(1)
    expect(sheetSummaries(ed)[0]?.tables).toHaveLength(1)
    expect(workbookNotes(ed).map((n) => n.kind)).not.toContain('tables')
  })

  it('supports hasHeaders: false by shifting existing cells down and writing Column1..ColumnN', () => {
    const bytes = buildXlsx({
      strings: ['Apple', 'Red'],
      sheets: [
        {
          name: 'S',
          rows: row(1, str('A1', 0) + num('B1', 10)) + row(2, str('A2', 1) + num('B2', 20)),
        },
      ],
    })
    const ed = createSheetEditor(bytes)
    ed.apply({ op: 'create_table', sheet: 'S', range: 'A1:B2', hasHeaders: false, name: 'Produce' })
    const out = ed.toBytes()
    const wb = openWorkbook(out)
    const t = findTable(wb, 'S', 'Produce')
    expect(rangeName(t.ref)).toBe('A1:B3')
    expect(t.columns.map((c) => c.name)).toEqual(['Column1', 'Column2'])
    const d = wb.sheet('S')
    expect(d.cells.get(cellKey(0, 0))?.value).toBe('Column1')
    expect(d.cells.get(cellKey(0, 1))?.value).toBe('Column2')
    expect(d.cells.get(cellKey(1, 0))?.value).toBe('Apple')
    expect(d.cells.get(cellKey(2, 1))?.value).toBe(20)
  })

  it('deduplicates blank/repeated headers and lets structured refs resolve immediately', () => {
    const bytes = buildXlsx({
      strings: ['Amt'],
      sheets: [
        {
          name: 'S',
          rows:
            row(1, str('A1', 0) + str('B1', 0)) +
            row(2, num('A2', 10) + num('B2', 20)),
        },
      ],
    })
    const ed = createSheetEditor(bytes)
    ed.apply({ op: 'create_table', sheet: 'S', range: 'A1:C2', name: 'Orders' })
    ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'E1', formula: 'SUM(Orders[Amt2])' }] })
    expect(ed.calc().cell('S', 0, 4).value).toBe(20)
    const t = findTable(ed.wb, 'S', 'Orders')
    expect(t.columns.map((c) => c.name)).toEqual(['Amt', 'Amt2', 'Column1'])
  })

  it('refuses invalid names, overlapping tables, or merged cells', () => {
    const bytes = buildXlsx({
      strings: ['A', 'B'],
      sheets: [
        {
          name: 'S',
          rows: row(1, str('A1', 0) + str('B1', 1)) + row(2, num('A2', 1) + num('B2', 2)),
          after: '<mergeCells count="1"><mergeCell ref="D1:E1"/></mergeCells>',
        },
      ],
    })
    const ed = createSheetEditor(bytes)
    expect(() =>
      ed.apply({ op: 'create_table', sheet: 'S', range: 'A1:B2', name: 'Bad Name' }),
    ).toThrow(/spaces/)
    expect(() =>
      ed.apply({ op: 'create_table', sheet: 'S', range: 'A1:B2', name: 'A1' }),
    ).toThrow(/cell reference/)
    expect(() =>
      ed.apply({ op: 'create_table', sheet: 'S', range: 'D1:E2' }),
    ).toThrow(/merged/)
    ed.apply({ op: 'create_table', sheet: 'S', range: 'A1:B2', name: 'Orders' })
    expect(() =>
      ed.apply({ op: 'create_table', sheet: 'S', range: 'B1:C3' }),
    ).toThrow(/overlaps table/)
  })

  it('toggles totals row with SUBTOTAL, supports per-column functions, and respects filtered rows', () => {
    const ed = createSheetEditor(salesBook())
    ed.apply({ op: 'create_table', sheet: 'Sales', range: 'A1:D4', name: 'Orders' })
    ed.apply({ op: 'update_table', sheet: 'Sales', table: 'Orders', totalsRow: true })

    let t = findTable(ed.wb, 'Sales', 'Orders')
    expect(rangeName(t.ref)).toBe('A1:D5')
    expect(t.totalsRowCount).toBe(1)
    // AutoFilter excludes totals row!
    expect(t.autoFilter?.range).toEqual({ top: 0, left: 0, bottom: 3, right: 3 })
    expect(ed.calc().cell('Sales', 4, 0).value).toBe('Total')
    expect(ed.calc().cell('Sales', 4, 3).value).toBe(69)
    expect(ed.wb.sheet('Sales').cells.get(cellKey(4, 3))?.formula).toBe('SUBTOTAL(109,Orders[Total])')

    // Change column functions & custom formula
    ed.apply({
      op: 'update_table',
      sheet: 'Sales',
      table: 'Orders',
      totalsColumns: [
        { column: 'Qty', function: 'sum' },
        { column: 'Price', function: 'average' },
        { column: 'Total', function: 'max' },
      ],
    })
    expect(ed.calc().cell('Sales', 4, 1).value).toBe(23)
    expect(ed.calc().cell('Sales', 4, 2).value).toBeCloseTo(3.1666666667, 5)
    expect(ed.calc().cell('Sales', 4, 3).value).toBe(25)

    // Filter out Apple -> SUBTOTAL updates to Banana + Cherry only
    ed.apply({ op: 'filter_column', sheet: 'Sales', col: 0, values: ['Banana', 'Cherry'] })
    expect(ed.calc().cell('Sales', 4, 1).value).toBe(13) // 5 + 8
    expect(ed.calc().cell('Sales', 4, 3).value).toBe(24) // max(20, 24)
    expect(ed.wb.sheet('Sales').rows.get(4)?.hidden ?? false).toBe(false) // totals row stays visible!

    // Turning totalsRow off clears row and shrinks range back to A1:D4
    ed.apply({ op: 'update_table', sheet: 'Sales', table: 'Orders', totalsRow: false })
    t = findTable(ed.wb, 'Sales', 'Orders')
    expect(rangeName(t.ref)).toBe('A1:D4')
    expect(t.totalsRowCount).toBe(0)
    expect(ed.wb.sheet('Sales').cells.get(cellKey(4, 3))).toBeUndefined()
  })

  it('sorts and filters an Excel table without tables loss and keeps totals row pinned', () => {
    const ed = createSheetEditor(salesBook())
    ed.apply({ op: 'create_table', sheet: 'Sales', range: 'A1:D4', name: 'Orders' })
    ed.apply({ op: 'update_table', sheet: 'Sales', table: 'Orders', totalsRow: true })

    // No tables loss when sorting the table cleanly
    const sortOp = {
      op: 'sort_range' as const,
      sheet: 'Sales',
      range: 'A1:D5',
      header: true,
      keys: [{ col: 1, descending: false }],
    }
    expect(sortLosses(ed.wb, sortOp)).toEqual([])
    ed.apply(sortOp)
    expect([1, 2, 3].map((r) => ed.wb.sheet('Sales').cells.get(cellKey(r, 0))?.value)).toEqual([
      'Banana',
      'Cherry',
      'Apple',
    ])
    // Totals row stayed at row 4
    expect(ed.wb.sheet('Sales').cells.get(cellKey(4, 0))?.value).toBe('Total')
    expect(tableXml(ed.toBytes(), 'Sales', 'Orders')).toContain('<sortState ref="A2:D4">')

    // columnChoices & toggling AutoFilter off/on for a table via single-cell set_autofilter
    expect(columnChoices(ed, 'Sales', 0).map((c) => c.value)).toEqual(['Apple', 'Banana', 'Cherry'])
    ed.apply({ op: 'filter_column', sheet: 'Sales', col: 0, values: ['Apple'] })
    expect(ed.wb.sheet('Sales').rows.get(1)?.hidden).toBe(true) // Banana row hidden
    expect(ed.wb.sheet('Sales').rows.get(3)?.hidden ?? false).toBe(false) // Apple row visible

    ed.apply({ op: 'set_autofilter', sheet: 'Sales', range: null, table: 'Orders' })
    expect(findTable(ed.wb, 'Sales', 'Orders').autoFilter).toBeNull()
    expect(ed.wb.sheet('Sales').rows.get(1)?.hidden ?? false).toBe(false)
    ed.apply({ op: 'set_autofilter', sheet: 'Sales', range: 'B2' })
    expect(findTable(ed.wb, 'Sales', 'Orders').autoFilter).not.toBeNull()
  })

  it('auto-expands when typing adjacent below (when no totals row) or to the right, and stops below totals row', () => {
    const ed = createSheetEditor(salesBook())
    ed.apply({ op: 'create_table', sheet: 'Sales', range: 'A1:D4', name: 'Orders' })

    // Typing below A5 expands table down to A1:D5
    ed.apply({
      op: 'set_cells',
      sheet: 'Sales',
      cells: [
        { ref: 'A5', value: 'DateFruit' },
        { ref: 'B5', value: 3 },
      ],
    })
    expect(rangeName(findTable(ed.wb, 'Sales', 'Orders').ref)).toBe('A1:D5')

    // Typing adjacent right in E1 & E2 adds a named column!
    ed.apply({
      op: 'set_cells',
      sheet: 'Sales',
      cells: [
        { ref: 'E1', value: 'Tax' },
        { ref: 'E2', value: 1.5 },
      ],
    })
    let t = findTable(ed.wb, 'Sales', 'Orders')
    expect(rangeName(t.ref)).toBe('A1:E5')
    expect(t.columns.at(-1)?.name).toBe('Tax')

    // With totals row enabled, typing below totals row does NOT expand
    ed.apply({ op: 'update_table', sheet: 'Sales', table: 'Orders', totalsRow: true })
    ed.apply({ op: 'set_cells', sheet: 'Sales', cells: [{ ref: 'A7', value: 'Outside' }] })
    t = findTable(ed.wb, 'Sales', 'Orders')
    expect(rangeName(t.ref)).toBe('A1:E6')
  })

  it('renames a table rewriting structured refs, toggles style & headerRow, resizes, and converts to range cleanly', () => {
    const ed = createSheetEditor(salesBook())
    ed.apply({ op: 'create_table', sheet: 'Sales', range: 'A1:D4', name: 'SalesTbl' })
    ed.apply({
      op: 'set_cells',
      sheet: 'Sales',
      cells: [{ ref: 'F1', formula: 'SUM(SalesTbl[Qty])' }],
    })
    expect(ed.calc().cell('Sales', 0, 5).value).toBe(23)

    // Style & banding & rename
    ed.apply({
      op: 'update_table',
      sheet: 'Sales',
      table: 'SalesTbl',
      name: 'Revenue',
      style: 'TableStyleMedium6',
      showRowStripes: true,
      showFirstColumn: true,
      headerRow: false,
    })
    let t = findTable(ed.wb, 'Sales', 'Revenue')
    expect(t.style.name).toBe('TableStyleMedium6')
    expect(t.style.showFirstColumn).toBe(true)
    expect(t.headerRowCount).toBe(0)
    expect(ed.wb.sheet('Sales').cells.get(cellKey(0, 5))?.formula).toBe('SUM(Revenue[Qty])')
    expect(ed.calc().cell('Sales', 0, 5).value).toBe(23)

    ed.apply({ op: 'update_table', sheet: 'Sales', table: 'Revenue', headerRow: true })
    t = findTable(ed.wb, 'Sales', 'Revenue')
    expect(tableCellLook([t], 0, 0)?.fill).toBe('#70AD47') // Green Medium 6 header
    expect(tableCellLook([t], 1, 0)?.fill).toBe('#E2EFDA') // banded even data row
    expect(tableCellLook([t], 2, 0)?.bold).toBe(true) // first column bold

    // Convert to range rewrites structured ref to A1 and removes table parts while keeping data
    ed.apply({ op: 'delete_table', sheet: 'Sales', table: 'Revenue' })
    expect(readSheetTables(ed.wb, 'Sales')).toEqual([])
    expect(ed.wb.sheet('Sales').cells.get(cellKey(0, 5))?.formula).toBe('B2:B4'.length ? 'SUM(B2:B4)' : '')
    const out = ed.toBytes()
    expect(openWorkbook(out).pkg.partNames().some((p) => p.includes('/tables/'))).toBe(false)
    expect(sheetXml(out)).not.toContain('tableParts')
    expect(createCalc(openWorkbook(out)).cell('Sales', 0, 5).value).toBe(23)
  })

  it('supports resize, undo/redo, and deletes table cells when mode is delete_cells', () => {
    const ed = createSheetEditor(salesBook())
    ed.apply({ op: 'create_table', sheet: 'Sales', range: 'A1:D4', name: 'Orders' })
    ed.apply({ op: 'update_table', sheet: 'Sales', table: 'Orders', ref: 'A1:C3' })
    expect(rangeName(findTable(ed.wb, 'Sales', 'Orders').ref)).toBe('A1:C3')

    ed.undo()
    expect(rangeName(findTable(ed.wb, 'Sales', 'Orders').ref)).toBe('A1:D4')

    ed.apply({ op: 'delete_table', sheet: 'Sales', table: 'Orders', mode: 'delete_cells' })
    expect(readSheetTables(ed.wb, 'Sales')).toEqual([])
    expect(ed.wb.sheet('Sales').cells.get(cellKey(0, 0))).toBeUndefined()
    ed.undo()
    expect(readSheetTables(ed.wb, 'Sales')).toHaveLength(1)
    expect(ed.wb.sheet('Sales').cells.get(cellKey(0, 0))?.value).toBe('Item')

    expect(() => ed.apply({ op: 'delete_table', sheet: 'Sales', table: 'Missing' })).toThrow(
      XlsxError,
    )
    const xmlStr = tableXml(ed.toBytes(), 'Sales', 'Orders')
    expect(kids(openWorkbook(ed.toBytes()).pkg.xml(findTable(openWorkbook(ed.toBytes()), 'Sales', 'Orders').part).documentElement!, 'tableColumns')).toHaveLength(1)
    expect(xmlStr).toContain('Orders')
  })
})
