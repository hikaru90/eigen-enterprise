import type { SheetOp } from '../ops'
import { describe, expect, it } from 'vitest'
import { rebaseItems, transformBody, UNDO_GONE, type LogBody } from './protocol'
import { COORDS, EFFECTS, SHEET_OP_NAMES, transform, transformLists, TransformRefusal } from './transform'

const write = (sheet: string, ...refs: string[]): SheetOp => ({
  op: 'set_cells',
  sheet,
  cells: refs.map((ref) => ({ ref, value: ref })),
})
const insertRows = (sheet: string, at: number, count = 1): SheetOp => ({ op: 'insert_rows', sheet, at, count })
const deleteRows = (sheet: string, at: number, count = 1): SheetOp => ({ op: 'delete_rows', sheet, at, count })
const insertCols = (sheet: string, at: number, count = 1): SheetOp => ({ op: 'insert_columns', sheet, at, count })
const deleteCols = (sheet: string, at: number, count = 1): SheetOp => ({ op: 'delete_columns', sheet, at, count })
const refs = (ops: SheetOp[]) =>
  ops.flatMap((o) => (o.op === 'set_cells' ? o.cells.map((c) => `${o.sheet}!${c.ref}`) : [o.op]))

describe('transform: cell edits against moving rows and columns', () => {
  it('two edits of the same cell both stay: the server’s order decides (last one wins)', () => {
    expect(transform(write('S', 'B2'), write('S', 'B2'))).toEqual([write('S', 'B2')])
  })

  it('an edit below an inserted row moves down; one above stays; another sheet is untouched', () => {
    expect(refs(transform(write('S', 'B5', 'B1'), insertRows('S', 2, 3)))).toEqual(['S!B8', 'S!B1'])
    expect(refs(transform(write('T', 'B5'), insertRows('S', 2)))).toEqual(['T!B5'])
    // The row the insertion starts at moves too (the new rows go before it).
    expect(refs(transform(write('S', 'A3'), insertRows('S', 2)))).toEqual(['S!A4'])
  })

  it('an edit in a deleted row goes; one below moves up; a write left with no cells goes', () => {
    expect(refs(transform(write('S', 'A2', 'A3', 'A9'), deleteRows('S', 1, 2)))).toEqual(['S!A7'])
    expect(transform(write('S', 'C2'), deleteRows('S', 0, 5))).toEqual([])
  })

  it('columns: inserted and deleted columns move edits sideways', () => {
    expect(refs(transform(write('S', 'C1', 'A1'), insertCols('S', 1, 2)))).toEqual(['S!E1', 'S!A1'])
    expect(refs(transform(write('S', 'C1', 'B1'), deleteCols('S', 1)))).toEqual(['S!B1'])
  })

  it('a formula typed meanwhile follows the moved cells, also from another sheet', () => {
    const typed: SheetOp = { op: 'set_cells', sheet: 'S', cells: [{ ref: 'A1', formula: '=SUM(B2:B10)+T!C4' }] }
    const [moved] = transform(typed, insertRows('S', 4, 2))
    expect(moved).toMatchObject({ cells: [{ ref: 'A1', formula: '=SUM(B2:B12)+T!C4' }] })
    const [other] = transform(typed, insertRows('T', 0))
    expect(other).toMatchObject({ cells: [{ ref: 'A1', formula: '=SUM(B2:B10)+T!C5' }] })
    const [gone] = transform({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'A1', formula: 'B3*2' }] }, deleteRows('S', 2))
    expect(gone).toMatchObject({ cells: [{ ref: 'A1', formula: '#REF!*2' }] })
  })

  it('ranges grow around an insertion and shrink with a deletion (all of it deleted: the change goes)', () => {
    const fmt: SheetOp = { op: 'set_format', sheet: 'S', range: 'B2:C5', format: '0%' }
    expect(transform(fmt, insertRows('S', 3))).toEqual([{ ...fmt, range: 'B2:C6' }])
    expect(transform(fmt, insertRows('S', 0))).toEqual([{ ...fmt, range: 'B3:C6' }])
    expect(transform(fmt, deleteRows('S', 0, 2))).toEqual([{ ...fmt, range: 'B1:C3' }])
    expect(transform(fmt, deleteCols('S', 1, 2))).toEqual([])
  })

  it('column widths, sort keys, filter columns and frozen panes move with their axis', () => {
    expect(transform({ op: 'set_column_width', sheet: 'S', from: 2, to: 4, width: 9 }, insertCols('S', 0))).toEqual([
      { op: 'set_column_width', sheet: 'S', from: 3, to: 5, width: 9 },
    ])
    expect(
      transform({ op: 'sort_range', sheet: 'S', range: 'A1:D9', keys: [{ col: 1 }, { col: 3, descending: true }] }, deleteCols('S', 1)),
    ).toEqual([{ op: 'sort_range', sheet: 'S', range: 'A1:C9', keys: [{ col: 2, descending: true }] }])
    expect(transform({ op: 'filter_column', sheet: 'S', col: 2, values: ['x'] }, deleteCols('S', 2))).toEqual([])
    expect(transform({ op: 'freeze_panes', sheet: 'S', rows: 2, cols: 1 }, insertRows('S', 0))).toEqual([
      { op: 'freeze_panes', sheet: 'S', rows: 3, cols: 1 },
    ])
    expect(transform({ op: 'freeze_panes', sheet: 'S', rows: 2, cols: 1 }, insertRows('S', 5))).toEqual([
      { op: 'freeze_panes', sheet: 'S', rows: 2, cols: 1 },
    ])
  })
})

describe('transform: rows and columns against each other', () => {
  it('insertions at the same place both happen, the later one after the earlier', () => {
    expect(transform(insertRows('S', 3), insertRows('S', 3))).toEqual([insertRows('S', 4)])
    expect(transform(insertRows('S', 3), insertRows('S', 5))).toEqual([insertRows('S', 3)])
  })

  it('an insertion inside a deleted block lands where the block was', () => {
    expect(transform(insertRows('S', 4), deleteRows('S', 2, 5))).toEqual([insertRows('S', 2)])
    expect(transform(insertRows('S', 9), deleteRows('S', 2, 5))).toEqual([insertRows('S', 4)])
  })

  it('a deletion with rows inserted inside it keeps the new rows: it is split around them', () => {
    expect(transform(deleteRows('S', 2, 4), insertRows('S', 4, 3))).toEqual([deleteRows('S', 2, 2), deleteRows('S', 5, 2)])
    expect(transform(deleteRows('S', 2, 4), insertRows('S', 1))).toEqual([deleteRows('S', 3, 4)])
  })

  it('overlapping deletions delete each row once', () => {
    expect(transform(deleteRows('S', 2, 4), deleteRows('S', 4, 4))).toEqual([deleteRows('S', 2, 2)])
    expect(transform(deleteRows('S', 4, 4), deleteRows('S', 2, 4))).toEqual([deleteRows('S', 2, 2)])
    expect(transform(deleteRows('S', 3, 1), deleteRows('S', 0, 9))).toEqual([])
    expect(transform(deleteRows('S', 1, 9), deleteRows('S', 3, 2))).toEqual([deleteRows('S', 1, 7)])
  })

  it('rows and columns don’t move each other', () => {
    expect(transform(deleteRows('S', 2), insertCols('S', 0))).toEqual([deleteRows('S', 2)])
  })
})

describe('transform: sheets', () => {
  it('an edit on a renamed sheet follows the new name; formulas elsewhere too', () => {
    const rename: SheetOp = { op: 'rename_sheet', sheet: 'Data', name: 'Numbers' }
    expect(transform(write('Data', 'A1'), rename)).toEqual([write('Numbers', 'A1')])
    expect(transform(write('data', 'A1'), rename)).toEqual([write('Numbers', 'A1')])
    const [f] = transform({ op: 'set_cells', sheet: 'Sum', cells: [{ ref: 'A1', formula: '=Data!B2*2' }] }, rename)
    expect(f).toMatchObject({ cells: [{ ref: 'A1', formula: '=Numbers!B2*2' }] })
  })

  it('two renames of one sheet: the later one renames the already renamed sheet', () => {
    expect(transform({ op: 'rename_sheet', sheet: 'A', name: 'C' }, { op: 'rename_sheet', sheet: 'A', name: 'B' })).toEqual([
      { op: 'rename_sheet', sheet: 'B', name: 'C' },
    ])
  })

  it('edits on a deleted sheet go; a second delete of it goes; other sheets stay', () => {
    const del: SheetOp = { op: 'delete_sheet', sheet: 'Old' }
    expect(transform(write('Old', 'A1'), del)).toEqual([])
    expect(transform(del, del)).toEqual([])
    expect(transform({ op: 'rename_sheet', sheet: 'Old', name: 'X' }, del)).toEqual([])
    expect(transform(write('New', 'A1'), del)).toEqual([write('New', 'A1')])
    expect(transform({ op: 'add_sheet', name: 'Old' }, del)).toEqual([{ op: 'add_sheet', name: 'Old' }])
  })
})

describe('lists and bodies', () => {
  it('every operation of the union says where its coordinates are and what it moves', () => {
    expect(Object.keys(EFFECTS).sort()).toEqual(Object.keys(COORDS).sort())
  })

  it('a pending list made on top of itself is rewritten through the whole grid', () => {
    // Pending: insert a row at 1, then write A3 (made after the insertion). Remote: delete row 0.
    const [mine, theirs] = transformLists([insertRows('S', 1), write('S', 'A3')], [deleteRows('S', 0)], transform)
    expect(mine).toEqual([insertRows('S', 0), { op: 'set_cells', sheet: 'S', cells: [{ ref: 'A2', value: 'A3' }] }])
    // The remote deletion, seen after the pending ones, still deletes the same row.
    expect(theirs).toEqual([deleteRows('S', 0)])
  })

  it('an undo loses to a concurrent change (refused, with why); a change passes an undo unchanged', () => {
    const change: LogBody = { kind: 'change', ops: [write('S', 'A1')], acceptLosses: false }
    const undo: LogBody = { kind: 'revert', of: 'x', images: {} }
    expect(() => transformBody(undo, change)).toThrow(TransformRefusal)
    expect(() => transformBody(undo, change)).toThrow(UNDO_GONE)
    expect(transformBody(change, undo)).toEqual([change])
  })

  it('rebasing keeps each item’s identity and drops the ones with nothing left', () => {
    const items = [
      { opId: 'a', body: { kind: 'change', ops: [write('S', 'A2')], acceptLosses: false } as LogBody },
      { opId: 'b', body: { kind: 'change', ops: [write('S', 'A9')], acceptLosses: false } as LogBody },
    ]
    const { kept: out, refused } = rebaseItems(items, [{ kind: 'change', ops: [deleteRows('S', 1)], acceptLosses: true }])
    expect(refused).toEqual([])
    expect(out.map((i) => i.opId)).toEqual(['b'])
    expect(out[0]!.body).toEqual({ kind: 'change', ops: [write('S', 'A8')].map((o) => ({ ...o, cells: [{ ref: 'A8', value: 'A9' }] })), acceptLosses: false })
  })

  it('concurrent edits to the same cell preserve values and both remain transformable across lists', () => {
    const a: SheetOp = { op: 'set_cells', sheet: 'S', cells: [{ ref: 'B2', value: 'alice' }] }
    const b: SheetOp = { op: 'set_cells', sheet: 'S', cells: [{ ref: 'B2', value: 'bob' }] }
    const [aAfterB, bAfterA] = transformLists([a], [b], transform)
    expect(aAfterB).toEqual([a])
    expect(bAfterA).toEqual([b])
  })

  it('an operation the union does not have is refused, never guessed at', () => {
    const unknown = { op: 'set_comment', sheet: 'S', ref: 'B4' } as unknown as SheetOp
    expect(() => transform(write('S', 'A1'), unknown)).toThrow(/not a sheet operation/)
    expect(() => transform(unknown, insertRows('S', 0))).toThrow(/not a sheet operation/)
    expect(SHEET_OP_NAMES).toContain('set_cells')
    expect(SHEET_OP_NAMES).not.toContain('set_comment')
  })
})
