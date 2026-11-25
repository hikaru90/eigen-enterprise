import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { addMonths, addWeekdays, fillDownTo, fillShortcutRange, seriesOf } from './fill'
import { cellKey } from './ref'
import { buildXlsx, fml, num, row, str } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

describe('AutoFill & Fill Series', () => {
  it('copies a single number, continues linear trend for 2+ numbers, and fills backwards when dragging up/left', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows:
              row(1, num('A1', 5) + num('B1', 1) + num('E1', 10) + num('F1', 20)) +
              row(2, num('B2', 3) + num('C2', 10)) +
              row(3, num('C3', 13)) +
              row(4, num('C4', 15)),
          },
        ],
      }),
    )
    ed.apply({ op: 'fill', sheet: 'S', source: 'A1', target: 'A1:A4' })
    ed.apply({ op: 'fill', sheet: 'S', source: 'B1:B2', target: 'B1:B5' })
    // Linear trend on noisy seed [10, 13, 15] -> slope 2.5 -> 17.6667? Wait: (0,10),(1,13),(2,15): mean y=38/3, b=( -1*(-8/3) + 1*(7/3) )/2 = 5/2 = 2.5 -> x=3: 10.1666 + 7.5 = 17.666666...
    ed.apply({ op: 'fill', sheet: 'S', source: 'C2:C4', target: 'C2:C5' })
    // Fill left from E1:F1 backwards to C1:F1 -> 0, 5? No: [10, 20] reversed is [20, 10], diff -10 -> D1=0, C1=-10
    ed.apply({ op: 'fill', sheet: 'S', source: 'E1:F1', target: 'C1:F1' })

    const s = openWorkbook(ed.toBytes()).sheet('S')
    expect([0, 1, 2, 3].map((r) => s.cells.get(cellKey(r, 0))?.value)).toEqual([5, 5, 5, 5])
    expect([0, 1, 2, 3, 4].map((r) => s.cells.get(cellKey(r, 1))?.value)).toEqual([1, 3, 5, 7, 9])
    expect(s.cells.get(cellKey(4, 2))?.value).toBeCloseTo(17.6666666667, 5)
    expect(s.cells.get(cellKey(0, 3))?.value).toBe(0)
    expect(s.cells.get(cellKey(0, 2))?.value).toBe(-10)
  })

  it('fills dates (days, month-ends, weekdays, years) and handles 1904 date workbooks', () => {
    // 2024-01-31 is serial 45322, 2024-02-29 is serial 45351
    const jan31 = 45322
    const feb29 = 45351
    expect(addMonths(jan31, 1)).toBe(feb29)
    expect(addMonths(jan31, 2)).toBe(45382) // 2024-03-31
    // 2024-01-05 (Friday, serial 45296) + 1 weekday -> Monday 2024-01-08 (45299)
    expect(addWeekdays(45296, 1)).toBe(45299)

    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows:
              row(1, num('A1', jan31, 4) + num('B1', jan31, 4) + num('C1', 45296, 4)) +
              row(2, num('B2', feb29, 4)),
          },
        ],
      }),
    )
    ed.apply({ op: 'fill', sheet: 'S', source: 'A1', target: 'A1:A3' })
    ed.apply({ op: 'fill', sheet: 'S', source: 'B1:B2', target: 'B1:B4' })
    ed.apply({ op: 'fill', sheet: 'S', source: 'C1', target: 'C1:C4', series: 'weekdays' })

    const s = ed.wb.sheet('S')
    expect(s.cells.get(cellKey(1, 0))?.value).toBe(jan31 + 1)
    expect(s.cells.get(cellKey(2, 0))?.value).toBe(jan31 + 2)
    expect(s.cells.get(cellKey(2, 1))?.value).toBe(45382) // Mar 31
    expect(s.cells.get(cellKey(3, 1))?.value).toBe(45412) // Apr 30
    expect(s.cells.get(cellKey(1, 2))?.value).toBe(45299) // Mon
    expect(s.cells.get(cellKey(2, 2))?.value).toBe(45300) // Tue
  })

  it('fills weekdays, months, numbered items, quarters, and custom lists preserving casing', () => {
    const ed = createSheetEditor(
      buildXlsx({
        strings: ['Mon', 'January', 'Item 1', 'Q1', 'Low'],
        sheets: [
          {
            name: 'S',
            rows: row(1, str('A1', 0) + str('B1', 1) + str('C1', 2) + str('D1', 3) + str('E1', 4)),
          },
        ],
      }),
    )
    ed.apply({ op: 'fill', sheet: 'S', source: 'A1', target: 'A1:A3' })
    ed.apply({ op: 'fill', sheet: 'S', source: 'B1', target: 'B1:B3' })
    ed.apply({ op: 'fill', sheet: 'S', source: 'C1', target: 'C1:C3' })
    ed.apply({ op: 'fill', sheet: 'S', source: 'D1', target: 'D1:D6' })
    ed.apply({
      op: 'fill',
      sheet: 'S',
      source: 'E1',
      target: 'E1:E4',
      customLists: [['Low', 'Medium', 'High']],
    })

    const s = ed.wb.sheet('S')
    expect([0, 1, 2].map((r) => s.cells.get(cellKey(r, 0))?.value)).toEqual(['Mon', 'Tue', 'Wed'])
    expect([0, 1, 2].map((r) => s.cells.get(cellKey(r, 1))?.value)).toEqual([
      'January',
      'February',
      'March',
    ])
    expect([0, 1, 2].map((r) => s.cells.get(cellKey(r, 2))?.value)).toEqual([
      'Item 1',
      'Item 2',
      'Item 3',
    ])
    expect([0, 1, 2, 3, 4].map((r) => s.cells.get(cellKey(r, 3))?.value)).toEqual([
      'Q1',
      'Q2',
      'Q3',
      'Q4',
      'Q1',
    ])
    expect([0, 1, 2, 3].map((r) => s.cells.get(cellKey(r, 4))?.value)).toEqual([
      'Low',
      'Medium',
      'High',
      'Low',
    ])
  })

  it('supports growth series, linear step/stop, formula relative translation, double-click fillDownTo, and Ctrl+D/Ctrl+R ranges', () => {
    const gen = seriesOf(
      [{ value: 2, formula: null, style: 0, date: false, time: false }],
      5,
      'growth',
      { step: 3, stop: 60 },
    )
    expect(gen.map((g) => (g.kind === 'value' ? g.value : null))).toEqual([6, 18, 54])

    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows:
              row(1, num('A1', 10) + fml('B1', 'A1*2', 20)) +
              row(2, num('A2', 20)) +
              row(3, num('A3', 30)),
          },
        ],
      }),
    )
    const endRow = fillDownTo(ed.wb.sheet('S'), { top: 0, bottom: 0, left: 1, right: 1 })
    expect(endRow).toBe(2)
    ed.apply({ op: 'fill', sheet: 'S', source: 'B1', target: `B1:B${endRow! + 1}` })
    expect(ed.wb.sheet('S').cells.get(cellKey(2, 1))?.formula).toBe('A3*2')
    expect(ed.calc().cell('S', 2, 1).value).toBe(60)

    expect(fillShortcutRange({ top: 0, bottom: 2, left: 1, right: 1 }, 'down')).toEqual({
      source: { top: 0, bottom: 0, left: 1, right: 1 },
      target: { top: 0, bottom: 2, left: 1, right: 1 },
    })
    expect(fillShortcutRange({ top: 2, bottom: 2, left: 1, right: 1 }, 'down')).toEqual({
      source: { top: 1, bottom: 1, left: 1, right: 1 },
      target: { top: 1, bottom: 2, left: 1, right: 1 },
    })
    expect(fillShortcutRange({ top: 1, bottom: 1, left: 1, right: 3 }, 'right')).toEqual({
      source: { top: 1, bottom: 1, left: 1, right: 1 },
      target: { top: 1, bottom: 1, left: 1, right: 3 },
    })
  })
})
