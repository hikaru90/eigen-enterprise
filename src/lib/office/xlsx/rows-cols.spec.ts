import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { autofitColumnWidth, autofitRowHeight, outlineOf } from './rows-cols'
import { buildXlsx, num, row, str } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

describe('rows & columns: hide/unhide, outline grouping/collapse, autofit', () => {
  it('hides and unhides columns and rows cleanly without disturbing neighbours', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            before: '<cols><col min="1" max="4" width="15" customWidth="1"/></cols>',
            rows: row(1, num('A1', 1)) + row(2, num('A2', 2)) + row(3, num('A3', 3)),
          },
        ],
      }),
    )
    ed.apply({ op: 'hide_columns', sheet: 'S', from: 1, to: 2, hidden: true })
    ed.apply({ op: 'hide_rows', sheet: 'S', from: 1, to: 1, hidden: true })
    let s = openWorkbook(ed.toBytes()).sheet('S')
    expect(s.cols.map((c) => [c.min, c.max, c.hidden])).toEqual([
      [0, 0, false],
      [1, 2, true],
      [3, 3, false],
    ])
    expect(s.rows.get(1)?.hidden).toBe(true)
    expect(s.rows.get(2)?.hidden ?? false).toBe(false)

    ed.apply({ op: 'hide_columns', sheet: 'S', from: 1, to: 1, hidden: false })
    ed.apply({ op: 'hide_rows', sheet: 'S', from: 1, to: 1, hidden: false })
    s = openWorkbook(ed.toBytes()).sheet('S')
    expect(s.cols.find((c) => c.min === 1 && c.max === 1)?.hidden).toBe(false)
    expect(s.cols.find((c) => c.min === 2 && c.max === 2)?.hidden).toBe(true)
    expect(s.rows.get(1)?.hidden ?? false).toBe(false)
  })

  it('groups, ungroups, collapses/expands nested outlines and sets outline level', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows:
              row(1, num('A1', 1)) +
              row(2, num('A2', 2)) +
              row(3, num('A3', 3)) +
              row(4, num('A4', 4)) +
              row(5, num('A5', 10)),
          },
        ],
      }),
    )
    ed.apply({ op: 'group_rows', sheet: 'S', from: 1, to: 3 })
    ed.apply({ op: 'group_rows', sheet: 'S', from: 1, to: 2 })
    ed.apply({ op: 'group_columns', sheet: 'S', from: 0, to: 1 })
    const outline = outlineOf(ed.wb, 'S')
    expect(outline.maxRowLevel).toBe(2)
    expect(outline.maxColLevel).toBe(1)
    expect(outline.rows).toEqual([
      { from: 1, to: 3, level: 1, collapsed: false, summaryAt: 4 },
      { from: 1, to: 2, level: 2, collapsed: false, summaryAt: 3 },
    ])

    // Collapse inner level 2 group, then collapse outer group, then expand outer group (inner stays collapsed!)
    ed.apply({ op: 'collapse_rows', sheet: 'S', from: 1, to: 2, collapsed: true })
    expect(ed.wb.sheet('S').rows.get(1)?.hidden).toBe(true)
    expect(ed.wb.sheet('S').rows.get(3)?.hidden ?? false).toBe(false)

    ed.apply({ op: 'collapse_rows', sheet: 'S', from: 1, to: 3, collapsed: true })
    expect(ed.wb.sheet('S').rows.get(3)?.hidden).toBe(true)

    ed.apply({ op: 'collapse_rows', sheet: 'S', from: 1, to: 3, collapsed: false })
    expect(ed.wb.sheet('S').rows.get(3)?.hidden ?? false).toBe(false)
    expect(ed.wb.sheet('S').rows.get(1)?.hidden).toBe(true)

    // Level 2 shows level 1 rows (unhides all when level >= max+1)
    ed.apply({ op: 'set_outline_level', sheet: 'S', axis: 'row', level: 3 })
    expect(ed.wb.sheet('S').rows.get(1)?.hidden ?? false).toBe(false)

    // Collapse column group
    ed.apply({ op: 'collapse_columns', sheet: 'S', from: 0, to: 1, collapsed: true })
    expect(outlineOf(ed.wb, 'S').cols[0]?.collapsed).toBe(true)
    expect(ed.wb.sheet('S').cols.find((c) => c.min === 0)?.hidden).toBe(true)

    ed.apply({ op: 'ungroup_rows', sheet: 'S', from: 1, to: 2 })
    expect(outlineOf(ed.wb, 'S').maxRowLevel).toBe(1)
    const sheetXml = strFromU8(unzipSync(ed.toBytes())['xl/worksheets/sheet1.xml']!)
    expect(sheetXml).toContain('outlineLevelRow="1"')
    expect(sheetXml).toContain('outlineLevelCol="1"')
  })

  it('autofits column widths and row heights (including wrapped text and bold)', () => {
    const ed = createSheetEditor(
      buildXlsx({
        strings: ['Short', 'A much longer cell headline', 'Line1\nLine2\nLine3'],
        sheets: [
          {
            name: 'S',
            rows: row(1, str('A1', 0) + str('B1', 1, 1) + str('C1', 2)),
          },
        ],
      }),
    )
    ed.apply({ op: 'set_style', sheet: 'S', range: 'C1', style: { wrap: true } })
    const bw = autofitColumnWidth(ed.wb, 'S', 1)!
    expect(bw).toBeGreaterThan(25)
    const ch = autofitRowHeight(ed.wb, 'S', 0)!
    expect(ch).toBeGreaterThan(40)

    ed.apply({ op: 'autofit_columns', sheet: 'S', from: 0, to: 2 })
    ed.apply({ op: 'autofit_rows', sheet: 'S', from: 0, to: 0 })
    const s = openWorkbook(ed.toBytes()).sheet('S')
    expect(s.cols.find((c) => c.min === 1)?.widthPx).toBeGreaterThan(150)
    expect(s.rows.get(0)?.heightPx).toBeGreaterThan(50)
  })
})
