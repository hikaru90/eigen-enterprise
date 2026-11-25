import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { resolveGridKey } from './keyboard'
import { ctrlARange, jumpEdge, moveWithinSelection, selectionStats } from './selection'
import { budgetBook, buildXlsx, num, row } from './test-utils/build-xlsx'

describe('selection stats, Ctrl+Arrow navigation & keyboard parity', () => {
  it('computes Sum, Average and Count without double-counting overlapping multi-range selections', () => {
    const ed = createSheetEditor(budgetBook())
    const stats = selectionStats(ed, 'Budget', [
      { top: 1, bottom: 3, left: 1, right: 1 }, // B2 (1200), B3 (300), B4 (1500)
      { top: 2, bottom: 2, left: 0, right: 1 }, // A3 ('Food'), B3 (300 - overlap!)
    ])
    expect(stats).toEqual({
      count: 4,
      numericCount: 3,
      sum: 3000,
      average: 1000,
    })
  })

  it('jumps block edges on Ctrl+Arrow and skips hidden rows', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows:
              row(1, num('A1', 1)) +
              row(2, num('A2', 2)) +
              row(3, num('A3', 3)) +
              row(6, num('A6', 6)),
          },
        ],
      }),
    )
    ed.apply({ op: 'hide_rows', sheet: 'S', from: 1, to: 1, hidden: true })
    const data = ed.wb.sheet('S')
    // From A1 down -> skips hidden row 2, stops at last filled A3 (row 2)
    expect(jumpEdge(data, { row: 0, col: 0 }, 'down', 60, 26)).toEqual({ row: 2, col: 0 })
    // From A3 down (next is blank A4) -> jumps to next filled A6 (row 5)
    expect(jumpEdge(data, { row: 2, col: 0 }, 'down', 60, 26)).toEqual({ row: 5, col: 0 })
    // From A6 down -> jumps to bottom edge (row 59)
    expect(jumpEdge(data, { row: 5, col: 0 }, 'down', 60, 26)).toEqual({ row: 59, col: 0 })
  })

  it('wraps Tab and Enter inside multi-cell selections and expands Ctrl+A region before whole sheet', () => {
    const sel = [{ top: 1, bottom: 2, left: 1, right: 2 }]
    expect(moveWithinSelection(sel, { row: 1, col: 1 }, 'tab', false)).toEqual({ row: 1, col: 2 })
    expect(moveWithinSelection(sel, { row: 1, col: 2 }, 'tab', false)).toEqual({ row: 2, col: 1 })
    expect(moveWithinSelection(sel, { row: 2, col: 2 }, 'tab', false)).toEqual({ row: 1, col: 1 })
    expect(moveWithinSelection(sel, { row: 2, col: 1 }, 'enter', false)).toEqual({ row: 1, col: 2 })

    const ed = createSheetEditor(budgetBook())
    const d = ed.wb.sheet('Budget')
    const r1 = ctrlARange(d, { row: 1, col: 1 }, { top: 1, bottom: 1, left: 1, right: 1 }, 60, 26)
    expect(r1).toEqual({ top: 0, bottom: 3, left: 0, right: 3 })
    const r2 = ctrlARange(d, { row: 1, col: 1 }, r1, 60, 26)
    expect(r2).toEqual({ top: 0, bottom: 59, left: 0, right: 25 })

    expect(
      resolveGridKey({
        key: ' ',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        active: { row: 0, col: 1 },
        sel: { top: 0, bottom: 0, left: 1, right: 1 },
        selections: [{ top: 0, bottom: 0, left: 1, right: 1 }],
        rows: 60,
        cols: 26,
        visibleRows: 20,
        visibleCols: 10,
        data: d,
        hasFilterAtActive: false,
        endMode: false,
      }),
    ).toEqual({ kind: 'select_cols' })
  })
})
