import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { autoFilterOf, columnChoices, currentRegion } from './filter'
import { XlsxLossError } from './ops'
import { frozenOf } from './panes'
import { cellKey } from './ref'
import { compareSortValues, guessHeader } from './sort'
import { buildXlsx, esc, fml, num, row, str } from './test-utils/build-xlsx'
import { openWorkbook, type CellValue } from './workbook'

const parts = (bytes: Uint8Array) => unzipSync(bytes)
const xml = (bytes: Uint8Array, name: string) => strFromU8(parts(bytes)[name]!)
const sheetXml = (bytes: Uint8Array, n = 1) => xml(bytes, `xl/worksheets/sheet${n}.xml`)

/** A small table: header, four data rows (name, amount, formula), a second sheet that reads it. */
function people(extra: { after?: string; rels?: Array<{ id: string; type: string; target: string }>; parts?: Record<string, { xml: string; type: string }>; rows?: string } = {}) {
  return buildXlsx({
    strings: ['Name', 'Amount', 'Double', 'bob', 'Alice', 'carol', 'Dave'],
    sheets: [
      {
        name: 'Data',
        rows:
          extra.rows ??
          row(1, str('A1', 0, 1) + str('B1', 1, 1) + str('C1', 2, 1)) +
            row(2, str('A2', 3) + num('B2', 30) + fml('C2', 'B2*2+$B$6', 60)) +
            row(3, str('A3', 4) + num('B3', 10, 2) + fml('C3', 'B3*2+$B$6', 20)) +
            row(4, str('A4', 5) + num('B4', 40) + fml('C4', 'B4*2+$B$6', 80)) +
            row(5, str('A5', 6) + num('B5', 20) + fml('C5', 'B5*2+$B$6', 40)) +
            row(6, num('B6', 0)),
        after: extra.after,
        rels: extra.rels,
      },
      { name: 'Other', rows: row(1, fml('A1', 'Data!B2', 30)) },
    ],
    parts: extra.parts,
  })
}

const cellsOf = (bytes: Uint8Array, sheet: string, col: number, from: number, to: number) => {
  const s = openWorkbook(bytes).sheet(sheet)
  const out: Array<CellValue | undefined> = []
  for (let r = from; r <= to; r++) out.push(s.cells.get(cellKey(r, col))?.value)
  return out
}

describe('sort order (Excel: numbers < text < logical < errors, blanks last)', () => {
  const sorted = (vals: CellValue[], desc = false) =>
    [...vals].sort((a, b) => compareSortValues(a, b, desc))

  it('orders kinds as Excel does, text case-insensitively, blanks always last', () => {
    expect(sorted([true, 'b', null, 3, { error: '#N/A' }, 'A', false, -1])).toEqual([
      -1,
      3,
      'A',
      'b',
      false,
      true,
      { error: '#N/A' },
      null,
    ])
    expect(sorted([true, 'b', null, 3, { error: '#N/A' }, 'A', false, -1], true)).toEqual([
      { error: '#N/A' },
      true,
      false,
      'b',
      'A',
      3,
      -1,
      null,
    ])
    expect(compareSortValues('apple', 'APPLE', false)).toBe(0)
  })
})

describe('sort_range', () => {
  it('sorts rows under the header: values, styles and formulas move; relative references follow, absolute ones stay; other parts stay byte for byte', () => {
    const bytes = people()
    const ed = createSheetEditor(bytes)
    ed.apply({
      op: 'sort_range',
      sheet: 'Data',
      range: 'A1:C5',
      header: true,
      keys: [{ col: 1 }],
    })
    const out = ed.toBytes()
    expect(cellsOf(out, 'Data', 0, 0, 4)).toEqual(['Name', 'Alice', 'Dave', 'bob', 'carol'])
    expect(cellsOf(out, 'Data', 1, 1, 4)).toEqual([10, 20, 30, 40])
    const s = openWorkbook(out).sheet('Data')
    // B3 (10, yellow) moved to B2 with its fill.
    expect(s.cells.get(cellKey(1, 1))).toMatchObject({ value: 10, style: 2 })
    expect(s.cells.get(cellKey(1, 2))).toMatchObject({ formula: 'B2*2+$B$6', value: 20 })
    expect(s.cells.get(cellKey(4, 2))).toMatchObject({ formula: 'B5*2+$B$6', value: 80 })
    // The header stayed; the row outside the range stayed.
    expect(s.cells.get(cellKey(0, 1))).toMatchObject({ value: 'Amount', style: 1 })
    expect(s.cells.get(cellKey(5, 1))?.value).toBe(0)
    // References into the range from elsewhere are not rewritten (as in Excel).
    expect(openWorkbook(out).sheet('Other').cells.get(cellKey(0, 0))).toMatchObject({
      formula: 'Data!B2',
      value: 10,
    })
    expect(parts(out)['xl/styles.xml']).toEqual(parts(bytes)['xl/styles.xml'])
    expect(parts(out)['xl/theme/theme1.xml']).toEqual(parts(bytes)['xl/theme/theme1.xml'])
    expect(parts(out)['xl/sharedStrings.xml']).toEqual(parts(bytes)['xl/sharedStrings.xml'])
  })

  it('sorts descending, by several keys, without a header; cells outside the range’s columns stay', () => {
    const bytes = buildXlsx({
      strings: ['x', 'y'],
      sheets: [
        {
          name: 'S',
          rows:
            row(1, str('A1', 0) + num('B1', 1) + num('D1', 101)) +
            row(2, str('A2', 1) + num('B2', 2) + num('D2', 102)) +
            row(3, str('A3', 0) + num('B3', 3) + num('D3', 103)) +
            row(4, str('A4', 1) + num('B4', 4) + num('D4', 104)),
        },
      ],
    })
    const ed = createSheetEditor(bytes)
    ed.apply({
      op: 'sort_range',
      sheet: 'S',
      range: 'A1:B4',
      keys: [{ col: 0 }, { col: 1, descending: true }],
    })
    const out = ed.toBytes()
    expect(cellsOf(out, 'S', 0, 0, 3)).toEqual(['x', 'x', 'y', 'y'])
    expect(cellsOf(out, 'S', 1, 0, 3)).toEqual([3, 1, 4, 2])
    expect(cellsOf(out, 'S', 3, 0, 3)).toEqual([101, 102, 103, 104])
  })

  it('leaves hidden rows where they are (as Excel does) and sorts the visible ones around them', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows:
              row(1, num('A1', 4)) +
              row(2, num('A2', 9), ' hidden="1"') +
              row(3, num('A3', 1)) +
              row(4, num('A4', 2)),
          },
        ],
      }),
    )
    ed.apply({ op: 'sort_range', sheet: 'S', range: 'A1:A4', keys: [{ col: 0 }] })
    expect(cellsOf(ed.toBytes(), 'S', 0, 0, 3)).toEqual([1, 9, 2, 4])
  })

  it('writes shared formulas out per cell before moving them; a reference above row 1 becomes #REF!', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows:
              row(1, num('A1', 3) + '<c r="B1"><f t="shared" ref="B1:B3" si="0">A1*10</f><v>30</v></c>') +
              row(2, num('A2', 1) + '<c r="B2"><f t="shared" si="0"/><v>10</v></c>') +
              row(3, num('A3', 2) + '<c r="B3"><f t="shared" si="0"/><v>20</v></c>' + fml('C3', 'A2', 1)),
          },
        ],
      }),
    )
    ed.apply({ op: 'sort_range', sheet: 'S', range: 'A1:C3', keys: [{ col: 0 }] })
    const out = ed.toBytes()
    const s = openWorkbook(out).sheet('S')
    expect(sheetXml(out)).not.toContain('t="shared"')
    expect(s.cells.get(cellKey(0, 1))).toMatchObject({ formula: 'A1*10', value: 10 })
    expect(s.cells.get(cellKey(2, 1))).toMatchObject({ formula: 'A3*10', value: 30 })
    // C3 (=A2) moves with row 3 to row 2: its relative reference moves up one too.
    expect(s.cells.get(cellKey(1, 2))).toMatchObject({ formula: 'A1' })
  })

  it('moves single-cell hyperlinks with their cells', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows: row(1, num('A1', 2)) + row(2, num('A2', 1)),
            after: '<hyperlinks><hyperlink ref="A1" location="S!A1" display="two"/></hyperlinks>',
          },
        ],
      }),
    )
    ed.apply({ op: 'sort_range', sheet: 'S', range: 'A1:A2', keys: [{ col: 0 }] })
    expect(sheetXml(ed.toBytes())).toContain('<hyperlink ref="A2" location="S!A1" display="two"/>')
  })

  it('refuses merged cells, array formulas and keys outside the range, changing nothing', () => {
    const merged = createSheetEditor(
      people({ after: '<mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells>' }),
    )
    expect(() =>
      merged.apply({ op: 'sort_range', sheet: 'Data', range: 'A1:C5', header: true, keys: [{ col: 1 }] }),
    ).toThrow(/merged/)
    expect(merged.changed()).toBe(false)
    const arr = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows:
              row(1, num('A1', 2) + '<c r="B1"><f t="array" ref="B1:B2">A1:A2*2</f><v>4</v></c>') +
              row(2, num('A2', 1) + num('B2', 2)),
          },
        ],
      }),
    )
    expect(() =>
      arr.apply({ op: 'sort_range', sheet: 'S', range: 'A1:B2', keys: [{ col: 0 }] }),
    ).toThrow(/array formula/)
    expect(() =>
      arr.apply({ op: 'sort_range', sheet: 'S', range: 'A1:A2', keys: [{ col: 3 }] }),
    ).toThrow(/outside/)
  })

  it('names comments, pictures and tables in the range that would not move, and sorts only when accepted', () => {
    const ed = createSheetEditor(
      people({
        after:
          '<drawing r:id="rId1"/><legacyDrawing r:id="rId3"/><tableParts count="1"><tablePart r:id="rId2"/></tableParts>',
        rels: [
          { id: 'rId1', type: 'drawing', target: '../drawings/drawing1.xml' },
          { id: 'rId2', type: 'table', target: '../tables/table1.xml' },
          { id: 'rId3', type: 'comments', target: '../comments1.xml' },
        ],
        parts: {
          '/xl/drawings/drawing1.xml': {
            xml: '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from></xdr:oneCellAnchor><xdr:oneCellAnchor><xdr:from><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from></xdr:oneCellAnchor></xdr:wsDr>',
            type: 'application/vnd.openxmlformats-officedocument.drawing+xml',
          },
          '/xl/tables/table1.xml': {
            xml: `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" ref="A1:C5"/>`,
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml',
          },
          '/xl/comments1.xml': {
            xml: `<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>a</author></authors><commentList><comment ref="B3" authorId="0"><text><t>${esc('hi')}</t></text></comment><comment ref="H9" authorId="0"><text><t>far</t></text></comment></commentList></comments>`,
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml',
          },
        },
      }),
    )
    const op = {
      op: 'sort_range' as const,
      sheet: 'Data',
      range: 'A1:C5',
      header: true,
      keys: [{ col: 1 }],
    }
    expect(ed.losses(op)).toEqual([
      { feature: 'tables', count: 1 },
      { feature: 'drawings', count: 1 },
      { feature: 'comments', count: 1 },
    ])
    expect(() => ed.apply(op)).toThrow(XlsxLossError)
    ed.apply(op, { acceptLosses: true })
    expect(cellsOf(ed.toBytes(), 'Data', 1, 1, 4)).toEqual([10, 20, 30, 40])
  })

  it('is undone as a whole', () => {
    const bytes = people()
    const ed = createSheetEditor(bytes)
    ed.apply({ op: 'sort_range', sheet: 'Data', range: 'A2:C5', keys: [{ col: 0, descending: true }] })
    expect(cellsOf(ed.toBytes(), 'Data', 0, 1, 4)).toEqual(['Dave', 'carol', 'bob', 'Alice'])
    ed.undo()
    expect(cellsOf(ed.toBytes(), 'Data', 0, 1, 4)).toEqual(['bob', 'Alice', 'carol', 'Dave'])
  })

  it('guesses a header row the way Excel’s quick sort does (text over other kinds, or a different format)', () => {
    const ed = createSheetEditor(people())
    expect(guessHeader(ed, 'Data', { top: 0, left: 0, bottom: 4, right: 2 })).toBe(true)
    expect(guessHeader(ed, 'Data', { top: 1, left: 0, bottom: 4, right: 2 })).toBe(false)
  })
})

describe('autoFilter', () => {
  it('turns on for a range (a single cell: its current region) as <autoFilter> plus Excel’s hidden _FilterDatabase name', () => {
    const bytes = people()
    const ed = createSheetEditor(bytes)
    expect(currentRegion(ed.wb.sheet('Data'), { row: 2, col: 1 })).toEqual({
      top: 0,
      left: 0,
      bottom: 5,
      right: 2,
    })
    ed.apply({ op: 'set_autofilter', sheet: 'Data', range: 'B3' })
    const out = ed.toBytes()
    expect(sheetXml(out)).toMatch(/<\/sheetData><autoFilter ref="A1:C6"\/><pageMargins/)
    expect(xml(out, 'xl/workbook.xml')).toContain(
      '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Data!$A$1:$C$6</definedName>',
    )
    expect(autoFilterOf(openWorkbook(out), 'Data')).toEqual({
      range: { top: 0, left: 0, bottom: 5, right: 2 },
      columns: [],
    })
    expect(sheetXml(out, 2)).toBe(sheetXml(bytes, 2))
  })

  it('filters a column by values (shown text, any case, blanks on request): other rows are hidden; clearing shows them again', () => {
    const ed = createSheetEditor(people())
    ed.apply({ op: 'set_autofilter', sheet: 'Data', range: 'A1:C6' })
    expect(columnChoices(ed, 'Data', 0)).toEqual([
      { value: 'Alice', label: 'Alice', count: 1 },
      { value: 'bob', label: 'bob', count: 1 },
      { value: 'carol', label: 'carol', count: 1 },
      { value: 'Dave', label: 'Dave', count: 1 },
      { value: '', label: '', count: 1 },
    ])
    ed.apply({ op: 'filter_column', sheet: 'Data', col: 0, values: ['ALICE', 'dave'] })
    let out = ed.toBytes()
    let s = openWorkbook(out).sheet('Data')
    expect([1, 2, 3, 4, 5].map((r) => s.rows.get(r)?.hidden ?? false)).toEqual([
      true,
      false,
      true,
      false,
      true,
    ])
    expect(sheetXml(out)).toContain(
      '<autoFilter ref="A1:C6"><filterColumn colId="0"><filters><filter val="ALICE"/><filter val="dave"/></filters></filterColumn></autoFilter>',
    )
    ed.apply({ op: 'filter_column', sheet: 'Data', col: 0, values: ['bob'], blanks: true })
    s = openWorkbook(ed.toBytes()).sheet('Data')
    expect([1, 2, 3, 4, 5].map((r) => s.rows.get(r)?.hidden ?? false)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ])
    expect(autoFilterOf(ed.wb, 'Data')?.columns).toEqual([
      { col: 0, kind: 'values', values: ['bob'], blanks: true },
    ])
    // Two columns: both must pass.
    ed.apply({ op: 'filter_column', sheet: 'Data', col: 1, values: ['0'] })
    s = openWorkbook(ed.toBytes()).sheet('Data')
    expect([1, 2, 3, 4, 5].map((r) => s.rows.get(r)?.hidden ?? false)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ])
    ed.apply({ op: 'filter_column', sheet: 'Data', col: 1, values: null })
    ed.apply({ op: 'filter_column', sheet: 'Data', col: 0, values: null })
    out = ed.toBytes()
    s = openWorkbook(out).sheet('Data')
    expect([...s.rows.values()].some((r) => r.hidden)).toBe(false)
    expect(sheetXml(out)).toContain('<autoFilter ref="A1:C6"/>')
  })

  it('turning it off shows every row and removes the filter and its name', () => {
    const ed = createSheetEditor(people())
    ed.apply({ op: 'set_autofilter', sheet: 'Data', range: 'A1:C6' })
    ed.apply({ op: 'filter_column', sheet: 'Data', col: 0, values: ['bob'] })
    ed.apply({ op: 'set_autofilter', sheet: 'Data', range: null })
    const out = ed.toBytes()
    expect(sheetXml(out)).not.toContain('autoFilter')
    expect(sheetXml(out)).not.toContain('hidden=')
    expect(xml(out, 'xl/workbook.xml')).not.toContain('_FilterDatabase')
  })

  it('reads a filter Excel saved (values, blanks, criteria it can’t edit) and keeps Excel’s hidden rows for those', () => {
    const bytes = people({
      rows:
        row(1, str('A1', 0) + str('B1', 1)) +
        row(2, str('A2', 3) + num('B2', 30)) +
        row(3, str('A3', 4) + num('B3', 10), ' hidden="1"') +
        row(4, str('A4', 5) + num('B4', 40)),
      after:
        '<autoFilter ref="A1:B4"><filterColumn colId="0"><filters blank="1"><filter val="bob"/><filter val="carol"/></filters></filterColumn><filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="20"/></customFilters></filterColumn></autoFilter>',
    })
    const ed = createSheetEditor(bytes)
    expect(autoFilterOf(ed.wb, 'Data')).toEqual({
      range: { top: 0, left: 0, bottom: 3, right: 1 },
      columns: [
        { col: 0, kind: 'values', values: ['bob', 'carol'], blanks: true },
        { col: 1, kind: 'other' },
      ],
    })
    // Changing column A re-applies it; column B's rule is Excel's to evaluate: its hidden rows stay.
    ed.apply({ op: 'filter_column', sheet: 'Data', col: 0, values: ['bob', 'carol', 'Alice'] })
    const out = ed.toBytes()
    const s = openWorkbook(out).sheet('Data')
    expect([1, 2, 3].map((r) => s.rows.get(r)?.hidden ?? false)).toEqual([false, true, false])
    expect(sheetXml(out)).toContain(
      '<filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="20"/></customFilters></filterColumn>',
    )
  })

  it('refuses a filter over a table (tables filter themselves) and a column outside the filter', () => {
    const ed = createSheetEditor(
      people({
        after: '<tableParts count="1"><tablePart r:id="rId2"/></tableParts>',
        rels: [{ id: 'rId2', type: 'table', target: '../tables/table1.xml' }],
        parts: {
          '/xl/tables/table1.xml': {
            xml: `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" ref="A1:C5"/>`,
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml',
          },
        },
      }),
    )
    expect(() => ed.apply({ op: 'set_autofilter', sheet: 'Data', range: 'A1:C6' })).toThrow(/table/)
    expect(() => ed.apply({ op: 'filter_column', sheet: 'Data', col: 0, values: ['x'] })).toThrow(
      /no filter/,
    )
  })
})

describe('freeze panes', () => {
  it('freezes the top row, the first column, both at a cell, and unfreezes — written as Excel writes a frozen pane', () => {
    const bytes = people()
    const ed = createSheetEditor(bytes)
    ed.apply({ op: 'freeze_panes', sheet: 'Data', rows: 1, cols: 0 })
    let out = ed.toBytes()
    expect(sheetXml(out)).toContain(
      '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView>',
    )
    expect(frozenOf(openWorkbook(out), 'Data')).toEqual({ rows: 1, cols: 0 })
    ed.apply({ op: 'freeze_panes', sheet: 'Data', rows: 2, cols: 1 })
    out = ed.toBytes()
    expect(sheetXml(out)).toContain(
      '<pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/><selection pane="topRight"/><selection pane="bottomLeft"/><selection pane="bottomRight"/>',
    )
    expect(frozenOf(openWorkbook(out), 'Data')).toEqual({ rows: 2, cols: 1 })
    ed.apply({ op: 'freeze_panes', sheet: 'Data', rows: 0, cols: 0 })
    out = ed.toBytes()
    expect(sheetXml(out)).toContain('<sheetView workbookViewId="0"/>')
    expect(frozenOf(openWorkbook(out), 'Data')).toBeNull()
    expect(sheetXml(out, 2)).toBe(sheetXml(bytes, 2))
  })

  it('reads a frozen pane Excel saved (also below a scrolled top row) and makes a sheetViews when the sheet has none', () => {
    const saved = buildXlsx({
      sheets: [{ name: 'S', rows: row(1, num('A1', 1)) }],
    })
    const files = unzipSync(saved)
    files['xl/worksheets/sheet1.xml'] = strToU8(
      strFromU8(files['xl/worksheets/sheet1.xml']!).replace(
        '<sheetView workbookViewId="0"/>',
        '<sheetView tabSelected="1" workbookViewId="0"><pane xSplit="2" ySplit="1" topLeftCell="C2" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="D4" sqref="D4"/></sheetView>',
      ),
    )
    expect(frozenOf(openWorkbook(zipSync(files)), 'S')).toEqual({ rows: 1, cols: 2 })
    // Scrolled: the view starts at row 3, so rows 1–3 stay in place.
    const scrolled = unzipSync(zipSync(files))
    scrolled['xl/worksheets/sheet1.xml'] = strToU8(
      strFromU8(scrolled['xl/worksheets/sheet1.xml']!).replace(
        'tabSelected="1"',
        'tabSelected="1" topLeftCell="A3"',
      ),
    )
    expect(frozenOf(openWorkbook(zipSync(scrolled)), 'S')).toEqual({ rows: 3, cols: 2 })
    files['xl/worksheets/sheet1.xml'] = strToU8(
      strFromU8(files['xl/worksheets/sheet1.xml']!).replace(/<sheetViews>.*<\/sheetViews>/, ''),
    )
    const ed = createSheetEditor(zipSync(files))
    expect(frozenOf(ed.wb, 'S')).toBeNull()
    ed.apply({ op: 'freeze_panes', sheet: 'S', rows: 0, cols: 1 })
    expect(sheetXml(ed.toBytes())).toContain(
      '<dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" topLeftCell="B1" activePane="topRight" state="frozen"/><selection pane="topRight"/></sheetView></sheetViews><sheetFormatPr',
    )
  })
})
