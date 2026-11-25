import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { findCells, listGoToNames, resolveGoTo } from './find'
import { cellKey } from './ref'
import { budgetBook, buildXlsx, fml, num, row, str } from './test-utils/build-xlsx'

describe('Find, Replace & Go To', () => {
  it('finds in formulas or displayed values with matchCase, wholeCell, wildcards, and sheet/workbook scope', () => {
    const ed = createSheetEditor(budgetBook())
    // Formula search finds =SUM(B2:B3) and =SUM(Costs)
    expect(findCells(ed, { query: 'SUM(*)', sheet: 'Budget', lookIn: 'formulas' })).toEqual([
      { sheet: 'Budget', ref: 'B4', text: '=SUM(B2:B3)' },
      { sheet: 'Budget', ref: 'D4', text: '=SUM(Costs)' },
    ])
    // Value search finds 1500 in Budget and 3000 in Summary
    expect(findCells(ed, { query: '1500', sheet: null, lookIn: 'values' })).toEqual([
      { sheet: 'Budget', ref: 'B4', text: '1500' },
      { sheet: 'Budget', ref: 'D4', text: '1500' },
    ])
    // Case sensitivity and wholeCell
    expect(findCells(ed, { query: 'rent', sheet: 'Budget', matchCase: true })).toEqual([])
    expect(
      findCells(ed, { query: 'Rent', sheet: 'Budget', matchCase: true, wholeCell: true }),
    ).toHaveLength(1)
    expect(findCells(ed, { query: 'Re', sheet: 'Budget', wholeCell: true })).toEqual([])
    // Escaped wildcard ~*
    const starEd = createSheetEditor(
      buildXlsx({
        strings: ['a*b', 'axb'],
        sheets: [{ name: 'S', rows: row(1, str('A1', 0) + str('B1', 1)) }],
      }),
    )
    expect(findCells(starEd, { query: 'a~*b', sheet: 'S' }).map((h) => h.ref)).toEqual(['A1'])
  })

  it('replaces text, numbers and formulas across one sheet or the workbook', () => {
    const ed = createSheetEditor(budgetBook())
    ed.apply({
      op: 'replace',
      find: 'Budget',
      replace: 'Summary',
      sheet: 'Summary',
      matchCase: true,
    })
    // Summary!A1 had =Budget!B4*2, Summary!B1 had ='Budget'!C4
    expect(ed.wb.sheet('Summary').cells.get(cellKey(0, 0))?.formula).toBe('Summary!B4*2')

    const numEd = createSheetEditor(
      buildXlsx({
        strings: ['alpha', 'ALPHA'],
        sheets: [
          {
            name: 'S',
            rows: row(1, str('A1', 0) + str('B1', 1) + num('C1', 120) + fml('D1', 'A1', 'alpha')),
          },
        ],
      }),
    )
    numEd.apply({
      op: 'replace',
      find: '120',
      replace: '125',
      sheet: 'S',
      cells: [{ sheet: 'S', ref: 'C1' }],
    })
    expect(numEd.wb.sheet('S').cells.get(cellKey(0, 2))?.value).toBe(125)
    // Dynamic formula replacement attaches dynamicCm
    numEd.apply({ op: 'replace', find: '=A1', replace: '=SEQUENCE(2)', sheet: 'S' })
    expect(numEd.wb.sheet('S').cells.get(cellKey(0, 3))?.dynamic).toBe(true)
    expect(numEd.calc().cell('S', 1, 3).value).toBe(2)
  })

  it('resolves Go To (F5 / Name Box) for cells, ranges, cross-sheet refs and defined names', () => {
    const ed = createSheetEditor(budgetBook())
    expect(resolveGoTo(ed.wb, 'Budget', 'c4')).toEqual({
      sheet: 'Budget',
      range: { top: 3, bottom: 3, left: 2, right: 2 },
    })
    expect(resolveGoTo(ed.wb, 'Budget', 'Summary!A1:B1')).toEqual({
      sheet: 'Summary',
      range: { top: 0, bottom: 0, left: 0, right: 1 },
    })
    expect(resolveGoTo(ed.wb, 'Summary', 'Costs')).toEqual({
      sheet: 'Budget',
      range: { top: 1, bottom: 2, left: 1, right: 1 },
      name: 'Costs',
    })
    expect(listGoToNames(ed.wb, 'Budget').map((n) => n.name)).toEqual(['Costs'])
    expect(() => resolveGoTo(ed.wb, 'Budget', 'NotARange')).toThrow(/not a valid/)
  })
})
