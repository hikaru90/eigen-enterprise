import { describe, expect, it } from 'vitest'
import { readClip } from './clip'
import { createSheetEditor } from './editor'
import { rangeName } from './ref'
import { findTable, readSheetTables } from './tables'
import { buildXlsx, num, row, str } from './test-utils/build-xlsx'

/** Everyday editing (§7.7) next to Excel tables (§7.6). */

const book = () =>
  buildXlsx({
    strings: ['Fruit', 'Qty', 'Apple', 'Pear'],
    sheets: [
      {
        name: 'S',
        rows:
          row(1, str('A1', 0) + str('B1', 1)) +
          row(2, str('A2', 2) + num('B2', 3)) +
          row(3, str('A3', 3) + num('B3', 5)),
      },
      { name: 'T' },
    ],
  })

const withTable = () => {
  const ed = createSheetEditor(book())
  ed.apply({ op: 'create_table', sheet: 'S', range: 'A1:B3', name: 'Stock' })
  return ed
}

describe('everyday editing and Excel tables', () => {
  it('pasting right below a table grows it, as typing does', () => {
    const ed = withTable()
    const clip = readClip(ed, 'S', { top: 2, left: 0, bottom: 2, right: 1 }, 'book')
    ed.apply({ op: 'paste', sheet: 'S', at: 'A4', clip })
    expect(rangeName(findTable(ed.wb, 'S', 'Stock').ref)).toBe('A1:B4')
  })

  it('filling down from the last row grows the table over the filled rows', () => {
    const ed = withTable()
    ed.apply({ op: 'fill', sheet: 'S', source: 'B2:B3', target: 'B2:B6' })
    expect(rangeName(findTable(ed.wb, 'S', 'Stock').ref)).toBe('A1:B6')
  })

  it('cut and paste moves a table wholly inside the block (same sheet), with its AutoFilter', () => {
    const ed = withTable()
    const clip = readClip(ed, 'S', { top: 0, left: 0, bottom: 2, right: 1 }, 'book')
    ed.apply({ op: 'paste', sheet: 'S', at: 'D5', clip, cut: true })
    const t = findTable(ed.wb, 'S', 'Stock')
    expect(rangeName(t.ref)).toBe('D5:E7')
    expect(t.autoFilter ? rangeName(t.autoFilter.range) : null).toBe('D5:E7')
    expect(t.columns.map((c) => c.name)).toEqual(['Fruit', 'Qty'])
  })

  it('cut and paste to another sheet takes the table along; undo brings it back', () => {
    const ed = withTable()
    const clip = readClip(ed, 'S', { top: 0, left: 0, bottom: 2, right: 1 }, 'book')
    ed.apply({ op: 'paste', sheet: 'T', at: 'B2', clip, cut: true })
    expect(readSheetTables(ed.wb, 'S')).toEqual([])
    expect(rangeName(findTable(ed.wb, 'T', 'Stock').ref)).toBe('B2:C4')
    const again = createSheetEditor(ed.toBytes())
    expect(rangeName(findTable(again.wb, 'T', 'Stock').ref)).toBe('B2:C4')
    ed.undo()
    expect(rangeName(findTable(ed.wb, 'S', 'Stock').ref)).toBe('A1:B3')
    expect(readSheetTables(ed.wb, 'T')).toEqual([])
  })

  it('a cut that holds only part of a table leaves the table where it is', () => {
    const ed = withTable()
    const clip = readClip(ed, 'S', { top: 1, left: 0, bottom: 2, right: 1 }, 'book')
    ed.apply({ op: 'paste', sheet: 'S', at: 'D5', clip, cut: true })
    expect(rangeName(findTable(ed.wb, 'S', 'Stock').ref)).toBe('A1:B3')
  })
})
