import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createCalc } from './calc'
import { createSheetEditor, workbookNotes } from './editor'
import { findPivot, pivotCellLook, readSheetPivots, readWorkbookPivots } from './pivot'
import { computePivot } from './pivot-calc'
import { sheetSummaries } from './read'
import { cellKey, rangeName } from './ref'
import { buildXlsx, fml, num, row, str } from './test-utils/build-xlsx'
import { openWorkbook, XlsxError } from './workbook'
import { kids } from './xml'

function regionalSalesBook() {
  return buildXlsx({
    strings: [
      'Region',
      'Category',
      'Rep',
      'Year',
      'Amount',
      'Units',
      'East',
      'West',
      'Fruit',
      'Veg',
      'Alice',
      'Bob',
    ],
    sheets: [
      {
        name: 'Sales',
        rows:
          row(1, str('A1', 0) + str('B1', 1) + str('C1', 2) + str('D1', 3) + str('E1', 4) + str('F1', 5)) +
          row(2, str('A2', 6) + str('B2', 8) + str('C2', 10) + num('D2', 2024) + num('E2', 100) + num('F2', 4)) +
          row(3, str('A3', 6) + str('B3', 9) + str('C3', 11) + num('D3', 2024) + num('E3', 50) + num('F3', 2)) +
          row(4, str('A4', 6) + str('B4', 8) + str('C4', 10) + num('D4', 2025) + num('E4', 200) + num('F4', 8)) +
          row(5, str('A5', 7) + str('B5', 8) + str('C5', 11) + num('D5', 2024) + num('E5', 300) + num('F5', 10)) +
          row(6, str('A6', 7) + str('B6', 9) + str('C6', 10) + num('D6', 2025) + num('E6', 150) + fml('F6', '3+3', 6)),
      },
    ],
  })
}

describe('pivot-calc', () => {
  it('computes multi-level rows, columns, page filters, multiple measures, subtotals and grand totals', () => {
    const res = computePivot({
      fields: ['Region', 'Category', 'Amount', 'Units'],
      records: [
        { Region: 'East', Category: 'Fruit', Amount: 100, Units: 4 },
        { Region: 'East', Category: 'Veg', Amount: 50, Units: 2 },
        { Region: 'West', Category: 'Fruit', Amount: 300, Units: 10 },
      ],
      rowFields: ['Region', 'Category'],
      colFields: [],
      pageFields: [],
      dataFields: [
        { field: 'Amount', name: 'Sum of Amount', agg: 'sum' },
        { field: 'Units', name: 'Avg of Units', agg: 'average' },
      ],
      rowGrandTotals: true,
      colGrandTotals: true,
      subtotals: true,
    })

    // Header row: Region | Category | Sum of Amount | Avg of Units
    expect(res.matrix[0]).toEqual(['Region', 'Category', 'Sum of Amount', 'Avg of Units'])
    // East -> Fruit, Veg, East Total; West -> Fruit, West Total; Grand Total
    expect(res.matrix[1]).toEqual(['East', 'Fruit', 100, 4])
    expect(res.matrix[2]).toEqual([null, 'Veg', 50, 2])
    expect(res.matrix[3]).toEqual(['East Total', null, 150, 3])
    expect(res.matrix[4]).toEqual(['West', 'Fruit', 300, 10])
    expect(res.matrix[5]).toEqual(['West Total', null, 300, 10])
    expect(res.matrix[6]).toEqual(['Grand Total', null, 450, 16 / 3])

    expect(res.lookup('Sum of Amount', [])).toBe(450)
    expect(res.lookup('Amount', [['Region', 'East']])).toBe(150)
    expect(res.lookup('Avg of Units', [['Region', 'East']])).toBe(3)
    expect(res.lookup('Sum of Amount', [['Region', 'Missing']])).toEqual({ error: '#REF!' })
  })

  it('supports count, countNums, min, max, product, stdDev, var aggregations', () => {
    const recs = [
      { K: 'A', V: 10 },
      { K: 'A', V: 20 },
      { K: 'A', V: 'text' },
      { K: 'A', V: null },
    ]
    const evalAgg = (agg: Parameters<typeof computePivot>[0]['dataFields'][number]['agg']) =>
      computePivot({
        fields: ['K', 'V'],
        records: recs,
        rowFields: ['K'],
        colFields: [],
        pageFields: [],
        dataFields: [{ field: 'V', name: 'M', agg }],
        colGrandTotals: false,
      }).matrix[1]![1]

    expect(evalAgg('sum')).toBe(30)
    expect(evalAgg('count')).toBe(3)
    expect(evalAgg('countNums')).toBe(2)
    expect(evalAgg('average')).toBe(15)
    expect(evalAgg('min')).toBe(10)
    expect(evalAgg('max')).toBe(20)
    expect(evalAgg('product')).toBe(200)
    expect(evalAgg('stdDev')).toBeCloseTo(Math.sqrt(50), 8)
    expect(evalAgg('var')).toBe(50)
  })
})

describe('pivot tables in workbook', () => {
  it('creates a pivot on a new sheet with Excel-valid XML parts, rels, content types, and GETPIVOTDATA', () => {
    const ed = createSheetEditor(regionalSalesBook())
    const res = ed.apply({
      op: 'create_pivot',
      sourceSheet: 'Sales',
      source: 'A1:F6',
      rowFields: ['Region'],
      colFields: ['Year'],
      pageFields: [{ field: 'Category' }],
      dataFields: [{ field: 'Amount', agg: 'sum' }],
    })
    expect(res.focus).toBe('PivotTable1')
    expect(res.sheets).toEqual(['PivotTable1'])

    const out = ed.toBytes()
    const wb = openWorkbook(out)
    const pivot = findPivot(wb, 'PivotTable1', 'PivotTable1')
    expect(pivot.rowFields).toEqual(['Region'])
    expect(pivot.colFields).toEqual(['Year'])
    expect(pivot.pageFields).toEqual([{ field: 'Category' }])
    expect(pivot.dataFields[0]?.name).toBe('Sum of Amount')

    // Valid OOXML parts & relationships
    expect(wb.pkg.contentType(pivot.part)).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml',
    )
    expect(wb.pkg.contentType(pivot.cacheDefPart)).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml',
    )
    expect(wb.pkg.contentType(pivot.cacheRecordsPart!)).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml',
    )
    expect(wb.pkg.text(wb.part)).toContain('<pivotCaches><pivotCache cacheId="1"')
    expect(workbookNotes(ed).map((n) => n.kind)).not.toContain('pivot_tables')
    expect(sheetSummaries(ed).find((s) => s.name === 'PivotTable1')?.pivots).toHaveLength(1)

    // Page filter on rows A3:B3 -> Category | (All), blank row 4, headers at row 5 (A5:D5)
    const d = wb.sheet('PivotTable1')
    expect(d.cells.get(cellKey(2, 0))?.value).toBe('Category')
    expect(d.cells.get(cellKey(2, 1))?.value).toBe('(All)')
    expect(d.cells.get(cellKey(4, 0))?.value).toBe('Region')
    expect(d.cells.get(cellKey(4, 1))?.value).toBe('2024')
    expect(d.cells.get(cellKey(4, 2))?.value).toBe('2025')
    expect(d.cells.get(cellKey(4, 3))?.value).toBe('Grand Total')
    // East: 2024=150, 2025=200, Grand=350; West: 2024=300, 2025=150, Grand=450; Grand Row: 450, 350, 800
    expect(d.cells.get(cellKey(5, 0))?.value).toBe('East')
    expect(d.cells.get(cellKey(5, 1))?.value).toBe(150)
    expect(d.cells.get(cellKey(5, 2))?.value).toBe(200)
    expect(d.cells.get(cellKey(5, 3))?.value).toBe(350)
    expect(d.cells.get(cellKey(6, 0))?.value).toBe('West')
    expect(d.cells.get(cellKey(6, 1))?.value).toBe(300)
    expect(d.cells.get(cellKey(6, 2))?.value).toBe(150)
    expect(d.cells.get(cellKey(6, 3))?.value).toBe(450)
    expect(d.cells.get(cellKey(7, 0))?.value).toBe('Grand Total')
    expect(d.cells.get(cellKey(7, 3))?.value).toBe(800)

    // Visual cell look (page label bold/tint, headers filled, grand total double bottom)
    expect(pivotCellLook(wb, [pivot], 2, 0)?.bold).toBe(true)
    expect(pivotCellLook(wb, [pivot], 4, 1)?.fill).toBe('#D9E1F2')
    expect(pivotCellLook(wb, [pivot], 7, 1)?.borderBottom?.style).toBe('double')

    // GETPIVOTDATA evaluation from workbook formulas
    ed.apply({
      op: 'set_cells',
      sheet: 'PivotTable1',
      cells: [
        { ref: 'F1', formula: 'GETPIVOTDATA("Amount",A3)' },
        { ref: 'F2', formula: 'GETPIVOTDATA("Sum of Amount",A5,"Region","East","Year",2024)' },
        { ref: 'F3', formula: 'GETPIVOTDATA("Amount",A3,"Category","Fruit")' },
        { ref: 'F4', formula: 'GETPIVOTDATA("Amount",A3,"Region","Mars")' },
        { ref: 'F5', formula: 'GETPIVOTDATA("Amount",E1)' },
      ],
    })
    const c = ed.calc()
    expect(c.cell('PivotTable1', 0, 5).value).toBe(800)
    expect(c.cell('PivotTable1', 1, 5).value).toBe(150)
    expect(c.cell('PivotTable1', 2, 5).value).toBe(600)
    expect(c.cell('PivotTable1', 3, 5).value).toEqual({ error: '#REF!' })
    expect(c.cell('PivotTable1', 4, 5).value).toEqual({ error: '#REF!' })
  })

  it('creates a pivot from an Excel Table, updates fields/hiddenItems/filters, and refreshes after source edits', () => {
    const ed = createSheetEditor(regionalSalesBook())
    ed.apply({ op: 'create_table', sheet: 'Sales', range: 'A1:F6', name: 'Orders' })
    ed.apply({
      op: 'create_pivot',
      source: 'Orders',
      targetSheet: 'Sales',
      targetCell: 'H1',
      name: 'SalesPivot',
      rowFields: ['Region'],
      dataFields: [{ field: 'Units', agg: 'sum', name: 'Total Units' }],
    })
    let pv = findPivot(ed.wb, 'Sales', 'SalesPivot')
    expect(pv.sourceTable).toBe('Orders')
    expect(rangeName(pv.location)).toBe('H1:I4')
    expect(ed.wb.sheet('Sales').cells.get(cellKey(3, 8))?.value).toBe(30) // 4+2+8+10+6

    // Edit source formula/cell: the pivot (and GETPIVOTDATA) change only on Refresh, as in Excel.
    ed.apply({
      op: 'set_cells',
      sheet: 'Sales',
      cells: [
        { ref: 'F2', value: 14 },
        { ref: 'K1', formula: 'GETPIVOTDATA("Total Units",H1)' },
      ],
    })
    expect(ed.calc().cell('Sales', 0, 10).value).toBe(30)
    ed.apply({ op: 'refresh_pivot', sheet: 'Sales', pivot: 'SalesPivot' })
    expect(ed.wb.sheet('Sales').cells.get(cellKey(3, 8))?.value).toBe(40)
    expect(ed.calc().cell('Sales', 0, 10).value).toBe(40)

    // Update page filter & hiddenItems & aggregation
    ed.apply({
      op: 'update_pivot',
      sheet: 'Sales',
      pivot: 'SalesPivot',
      rowFields: ['Category'],
      pageFields: [{ field: 'Region', selectedItem: 'East' }],
      hiddenItems: { Category: ['Veg'] },
      dataFields: [{ field: 'Amount', agg: 'average', name: 'Avg Amt', numFmt: '0.00' }],
    })
    pv = findPivot(ed.wb, 'Sales', 'SalesPivot')
    expect(pv.pageFields[0]).toEqual({ field: 'Region', selectedItem: 'East' })
    expect(pv.hiddenItems).toEqual({ Category: ['Veg'] })
    const d = ed.wb.sheet('Sales')
    expect(d.cells.get(cellKey(0, 7))?.value).toBe('Region')
    expect(d.cells.get(cellKey(0, 8))?.value).toBe('East')
    expect(d.cells.get(cellKey(3, 7))?.value).toBe('Fruit')
    expect(d.cells.get(cellKey(3, 8))?.value).toBe(150) // avg(100, 200)
  })

  it('renders and refreshes a pre-existing Excel pivot table XML fixture and cleans up orphan cache on delete', () => {
    const bytes = buildXlsx({
      strings: ['Dept', 'Spend', 'Eng', 'Ops', 'Grand Total', 'Sum of Spend'],
      sheets: [
        {
          name: 'Raw',
          rows:
            row(1, str('A1', 0) + str('B1', 1)) +
            row(2, str('A2', 2) + num('B2', 100)) +
            row(3, str('A3', 3) + num('B3', 40)),
        },
        {
          name: 'Summary',
          rows:
            row(1, str('A1', 0) + str('B1', 5)) +
            row(2, str('A2', 2) + num('B2', 999)) + // stale value in Excel XML before refresh
            row(3, str('A3', 3) + num('B3', 1)) +
            row(4, str('A4', 4) + num('B4', 1000)),
          rels: [{ id: 'rId1', type: 'pivotTable', target: '../pivotTables/pivotTable1.xml' }],
        },
      ],
      parts: {
        '/xl/pivotTables/pivotTable1.xml': {
              type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml',
              xml: `<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="DeptPivot" cacheId="7"><location ref="A1:B4" firstHeaderRow="0" firstDataRow="1" firstDataCol="1"/><pivotFields count="2"><pivotField axis="axisRow" showAll="0"/><pivotField dataField="1" showAll="0"/></pivotFields><rowFields count="1"><field x="0"/></rowFields><dataFields count="1"><dataField name="Sum of Spend" fld="1" subtotal="sum"/></dataFields><pivotTableStyleInfo name="PivotStyleMedium9" showRowHeaders="1" showColHeaders="1"/></pivotTableDefinition>`,
            },
            '/xl/pivotTables/_rels/pivotTable1.xml.rels': {
              type: 'application/vnd.openxmlformats-officedocument.relationships+xml',
              xml: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition1.xml"/></Relationships>`,
            },
            '/xl/pivotCache/pivotCacheDefinition1.xml': {
              type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml',
              xml: `<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1" recordCount="2"><cacheSource type="worksheet"><worksheetSource ref="A1:B3" sheet="Raw"/></cacheSource><cacheFields count="2"><cacheField name="Dept" numFmtId="0"><sharedItems count="2"><s v="Eng"/><s v="Ops"/></sharedItems></cacheField><cacheField name="Spend" numFmtId="0"><sharedItems count="2"><n v="100"/><n v="40"/></sharedItems></cacheField></cacheFields></pivotCacheDefinition>`,
            },
            '/xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels': {
              type: 'application/vnd.openxmlformats-officedocument.relationships+xml',
              xml: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheRecords" Target="pivotCacheRecords1.xml"/></Relationships>`,
            },
            '/xl/pivotCache/pivotCacheRecords1.xml': {
              type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml',
              xml: `<pivotCacheRecords xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2"><r><x v="0"/><n v="100"/></r><r><x v="1"/><n v="40"/></r></pivotCacheRecords>`,
            },
      },
    })

    const ed = createSheetEditor(bytes)
    expect(readSheetPivots(ed.wb, 'Summary')).toHaveLength(1)
    expect(pivotCellLook(ed.wb, readSheetPivots(ed.wb, 'Summary'), 0, 0)?.fill).toBe('#4472C4')

    // Refresh updates stale cached cells (999 -> 100, 1 -> 40, 1000 -> 140)
    ed.apply({ op: 'refresh_pivot', sheet: 'Summary', pivot: 'DeptPivot' })
    expect(ed.wb.sheet('Summary').cells.get(cellKey(1, 1))?.value).toBe(100)
    expect(ed.wb.sheet('Summary').cells.get(cellKey(2, 1))?.value).toBe(40)
    expect(ed.wb.sheet('Summary').cells.get(cellKey(3, 1))?.value).toBe(140)

    // Delete cleans pivot + orphan cache parts + sheet cells, and undo restores cleanly
    ed.apply({ op: 'delete_pivot', sheet: 'Summary', pivot: 'DeptPivot' })
    expect(readWorkbookPivots(ed.wb)).toEqual([])
    expect(ed.wb.sheet('Summary').cells.get(cellKey(0, 0))).toBeUndefined()
    const out = openWorkbook(ed.toBytes())
    expect(out.pkg.partNames().some((p) => p.includes('pivot'))).toBe(false)
    expect(kids(out.pkg.xml(out.part).documentElement!, 'pivotCaches')).toEqual([])

    ed.undo()
    expect(readSheetPivots(ed.wb, 'Summary')).toHaveLength(1)
    expect(ed.wb.sheet('Summary').cells.get(cellKey(3, 1))?.value).toBe(140)

    // Keep values deletes pivot XML while retaining rendered values
    ed.apply({ op: 'delete_pivot', sheet: 'Summary', pivot: 'DeptPivot', keepValues: true })
    expect(readWorkbookPivots(ed.wb)).toEqual([])
    expect(ed.wb.sheet('Summary').cells.get(cellKey(3, 1))?.value).toBe(140)
    expect(createCalc(openWorkbook(ed.toBytes())).cell('Summary', 3, 1).value).toBe(140)
    expect(() =>
      ed.apply({ op: 'refresh_pivot', sheet: 'Summary', pivot: 'DeptPivot' }),
    ).toThrow(XlsxError)

    // What the editor doesn't model ("show values as", calculated fields, grouping …) is never dropped: refresh/edit refuse.
    const files = unzipSync(bytes)
    const pt = 'xl/pivotTables/pivotTable1.xml'
    files[pt] = strToU8(
      strFromU8(files[pt]!).replace('subtotal="sum"/>', 'subtotal="sum" showDataAs="percentOfTotal"/>'),
    )
    const shown = createSheetEditor(zipSync(files))
    expect(() =>
      shown.apply({ op: 'refresh_pivot', sheet: 'Summary', pivot: 'DeptPivot' }),
    ).toThrow(/show values as/)
    expect(() =>
      shown.apply({ op: 'update_pivot', sheet: 'Summary', pivot: 'DeptPivot', colFields: [] }),
    ).toThrow(/show values as/)
    expect(shown.changed()).toBe(false)
  })
})
