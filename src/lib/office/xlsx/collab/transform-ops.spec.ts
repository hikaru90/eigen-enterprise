import type { Clip } from '../clip'
import type { SheetOp } from '../ops'
import { describe, expect, it } from 'vitest'
import { rebaseItems, type LogBody } from './protocol'
import { transform, TransformRefusal } from './transform'

/**
 * The operations of the other xlsx streams (charts, drawings, notes and
 * comments, rules, tables, pivots, everyday editing) against concurrent
 * changes: what moves, and what is refused by name.
 */

const write = (sheet: string, ...refs: string[]): SheetOp => ({ op: 'set_cells', sheet, cells: refs.map((ref) => ({ ref, value: 1 })) })
const insertRows = (sheet: string, at: number, count = 1): SheetOp => ({ op: 'insert_rows', sheet, at, count })
const deleteRows = (sheet: string, at: number, count = 1): SheetOp => ({ op: 'delete_rows', sheet, at, count })
const insertCols = (sheet: string, at: number, count = 1): SheetOp => ({ op: 'insert_columns', sheet, at, count })
const refused = (a: SheetOp, b: SheetOp, why: RegExp) => {
  expect(() => transform(a, b)).toThrow(TransformRefusal)
  expect(() => transform(a, b)).toThrow(why)
}
const clip = (sheet: string, row: number, col: number, rows: number, cols: number): Clip => ({
  book: 'file-1',
  sheet,
  origin: { row, col },
  rows,
  cols,
  cells: [],
  merges: [],
})
const cutTo = (from: Clip, sheet: string, at: string): SheetOp => ({ op: 'paste', sheet, at, clip: from, cut: true })

describe('anchors, notes, comments and rule ranges follow inserted and deleted rows', () => {
  it('chart anchors move: a range anchor and cell markers alike', () => {
    expect(transform({ op: 'chart_move', sheet: 'S', chart: 'chart1', to: 'E2:L18' }, insertRows('S', 0, 2))).toEqual([
      { op: 'chart_move', sheet: 'S', chart: 'chart1', to: 'E4:L20' },
    ])
    const at = { from: { col: 1, colOff: 5, row: 5, rowOff: 9 }, to: { col: 6, colOff: 0, row: 10, rowOff: 0 } }
    expect(transform({ op: 'chart_move', sheet: 'S', chart: 'chart1', to: at }, insertRows('S', 2, 2))).toEqual([
      { op: 'chart_move', sheet: 'S', chart: 'chart1', to: { from: { ...at.from, row: 7 }, to: { ...at.to, row: 12 } } },
    ])
    // A marker in a deleted block lands where the block was.
    const [moved] = transform({ op: 'chart_move', sheet: 'S', chart: 'chart1', to: at }, deleteRows('S', 4, 3))
    expect(moved).toMatchObject({ to: { from: { row: 4, rowOff: 0 }, to: { row: 7 } } })
    // Series references follow the cells they read.
    const [created] = transform(
      { op: 'chart_create', sheet: 'S', type: 'bar', range: 'A1:B5', series: [{ values: 'S!$B$2:$B$5', name: { ref: 'S!$B$1' } }] },
      insertRows('S', 0),
    )
    expect(created).toMatchObject({ range: 'A2:B6', series: [{ values: 'S!$B$3:$B$6', name: { ref: 'S!$B$2' } }] })
  })

  it('notes and comments move with their cell, and go with a deleted one', () => {
    expect(transform({ op: 'set_note', sheet: 'S', ref: 'B5', text: 'x' }, insertRows('S', 0))).toEqual([
      { op: 'set_note', sheet: 'S', ref: 'B6', text: 'x' },
    ])
    expect(transform({ op: 'delete_note', sheet: 'S', ref: 'B5' }, deleteRows('S', 4))).toEqual([])
    expect(
      transform({ op: 'add_comment', sheet: 'S', ref: 'C3', text: 'hi', author: { id: 'u', name: 'U' }, now: 't' }, insertCols('S', 0)),
    ).toEqual([{ op: 'add_comment', sheet: 'S', ref: 'D3', text: 'hi', author: { id: 'u', name: 'U' }, now: 't' }])
  })

  it('conditional formats, validation and links: ranges and rule formulas move', () => {
    const [cf] = transform(
      { op: 'cf_add', sheet: 'S', range: 'A1:A10', rule: { type: 'expression', formula1: '=A1>B$1' } as never },
      insertRows('S', 0),
    )
    expect(cf).toMatchObject({ range: 'A2:A11', rule: { formula1: '=A2>B$2' } })
    expect(transform({ op: 'validation_set', sheet: 'S', range: 'C2:C9', rule: { type: 'whole' } as never }, deleteRows('S', 0))).toEqual([
      { op: 'validation_set', sheet: 'S', range: 'C1:C8', rule: { type: 'whole' } },
    ])
    expect(transform({ op: 'hyperlink_set', sheet: 'S', range: 'B2', target: 'https://x' }, insertCols('S', 1))).toEqual([
      { op: 'hyperlink_set', sheet: 'S', range: 'C2', target: 'https://x' },
    ])
  })

  it('names follow a renamed sheet (scope and reference) and go with a deleted scope', () => {
    const add: SheetOp = { op: 'name_add', name: 'Total', refersTo: 'Data!$B$9', scope: 'Data' }
    expect(transform(add, { op: 'rename_sheet', sheet: 'Data', name: 'Numbers' })).toEqual([
      { op: 'name_add', name: 'Total', refersTo: 'Numbers!$B$9', scope: 'Numbers' },
    ])
    expect(transform(add, { op: 'delete_sheet', sheet: 'Data' })).toEqual([])
    expect(transform({ ...add, scope: null }, insertRows('Data', 0))).toEqual([{ ...add, scope: null, refersTo: 'Data!$B$10' }])
  })

  it('a PivotTable’s source and target follow their own sheets', () => {
    const [p] = transform(
      { op: 'create_pivot', sourceSheet: 'Data', source: 'A1:D9', targetSheet: 'Report', targetCell: 'B3' },
      insertRows('Data', 0),
    )
    expect(p).toMatchObject({ source: 'A2:D10', targetCell: 'B3' })
    const [q] = transform({ op: 'create_pivot', source: 'Data!A1:D9', targetSheet: 'Report', targetCell: 'B3' }, insertRows('Report', 0))
    expect(q).toMatchObject({ source: 'Data!A1:D9', targetCell: 'B4' })
  })

  it('find and replace in chosen cells: each cell follows its own sheet', () => {
    const op: SheetOp = { op: 'replace', find: 'a', replace: 'b', sheet: null, cells: [{ sheet: 'S', ref: 'A2' }, { sheet: 'T', ref: 'A2' }] }
    expect(transform(op, deleteRows('S', 1))).toEqual([{ ...op, cells: [{ sheet: 'T', ref: 'A2' }] }])
  })

  it('hidden, grouped and autofitted rows/columns, print areas and fills move', () => {
    expect(transform({ op: 'hide_rows', sheet: 'S', from: 3, to: 5, hidden: true }, insertRows('S', 0, 2))).toEqual([
      { op: 'hide_rows', sheet: 'S', from: 5, to: 7, hidden: true },
    ])
    expect(transform({ op: 'set_page_setup', sheet: 'S', printArea: '$A$1:$D$20', repeatRows: '$1:$2' }, insertRows('S', 0))).toEqual([
      { op: 'set_page_setup', sheet: 'S', printArea: '$A$2:$D$21', repeatRows: '$2:$3' },
    ])
    expect(transform({ op: 'fill', sheet: 'S', source: 'A1:A2', target: 'A1:A10' }, insertRows('S', 5))).toEqual([
      { op: 'fill', sheet: 'S', source: 'A1:A2', target: 'A1:A11' },
    ])
  })

  it('a batch moves operation by operation, and a batch moves others in order', () => {
    expect(transform({ op: 'batch', ops: [write('S', 'A5'), write('S', 'B5')] }, insertRows('S', 0))).toEqual([
      { op: 'batch', ops: [write('S', 'A6'), write('S', 'B6')] },
    ])
    expect(
      transform(write('S', 'A5'), { op: 'batch', ops: [insertRows('S', 0), { op: 'rename_sheet', sheet: 'S', name: 'T' }] }),
    ).toEqual([write('T', 'A6')])
  })
})

describe('cut and paste moves what lay in the cut block', () => {
  it('an edit inside the cut block goes along with it; one outside stays', () => {
    const cut = cutTo(clip('S', 0, 0, 3, 2), 'S', 'D10')
    expect(transform(write('S', 'A2'), cut)).toEqual([write('S', 'D11')])
    expect(transform(write('S', 'H1'), cut)).toEqual([write('S', 'H1')])
    // A formula pointing wholly into the block follows it (Excel's cut).
    const [f] = transform({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'H1', formula: '=SUM(A1:B2)' }] }, cut)
    expect(f).toMatchObject({ cells: [{ ref: 'H1', formula: '=SUM(D10:E11)' }] })
  })

  it('a range only partly inside the cut block, or a block cut to another sheet, is refused', () => {
    const cut = cutTo(clip('S', 0, 0, 3, 2), 'S', 'D10')
    refused({ op: 'set_format', sheet: 'S', range: 'A2:C2', format: '0%' }, cut, /part of A2:C2 was cut and pasted elsewhere/)
    refused(write('S', 'A1'), cutTo(clip('S', 0, 0, 3, 2), 'T', 'A1'), /cut and pasted onto T/)
  })

  it('a pending cut whose source rows moved is refused (its block is somewhere else now)', () => {
    refused(cutTo(clip('S', 4, 0, 2, 2), 'S', 'H1'), insertRows('S', 0), /where you cut from/)
    // Rows below the block don't move it.
    expect(transform(cutTo(clip('S', 4, 0, 2, 2), 'S', 'H1'), insertRows('S', 20))).toHaveLength(1)
  })
})

describe('changes that rewrite or reorder cells refuse what lay in them', () => {
  it('sort: an edit inside the sorted range is refused; outside stands', () => {
    const sort: SheetOp = { op: 'sort_range', sheet: 'S', range: 'A1:C9', keys: [{ col: 0 }] }
    refused(write('S', 'B3'), sort, /S!A1:C9 was sorted/)
    expect(transform(write('S', 'B20'), sort)).toEqual([write('S', 'B20')])
  })

  it('merge: a write into the merged range is refused, except its top-left cell', () => {
    const merge: SheetOp = { op: 'merge_cells', sheet: 'S', range: 'A1:C1', mode: 'merge' }
    refused(write('S', 'B1'), merge, /was merged/)
    expect(transform(write('S', 'A1'), merge)).toEqual([write('S', 'A1')])
    expect(transform(write('S', 'B1'), { ...merge, mode: 'unmerge' } as SheetOp)).toEqual([write('S', 'B1')])
  })

  it('a refreshed or changed PivotTable refuses cell edits on its sheet (its size is not known ahead)', () => {
    refused(write('P', 'Z99'), { op: 'refresh_pivot', sheet: 'P', pivot: 'Pivot1' }, /PivotTable Pivot1/)
    expect(transform(write('Q', 'A1'), { op: 'refresh_pivot', sheet: 'P', pivot: 'Pivot1' })).toEqual([write('Q', 'A1')])
  })

  it('a table’s explicit new range is refused after the sheet’s tables may have grown', () => {
    const resize: SheetOp = { op: 'update_table', sheet: 'S', table: 'T1', ref: 'A1:C9' }
    refused(resize, write('S', 'A10'), /tables of S may have grown/)
    expect(transform({ op: 'update_table', sheet: 'S', table: 'T1', style: 'TableStyleLight1' }, write('S', 'A10'))).toHaveLength(1)
  })

  it('a conditional format addressed by priority is refused after the rules were renumbered', () => {
    const upd: SheetOp = { op: 'cf_update', sheet: 'S', priority: 2, range: 'A1:A3' }
    refused(upd, { op: 'cf_delete', sheet: 'S', priority: 1 }, /renumbered/)
    expect(transform(upd, { op: 'cf_delete', sheet: 'T', priority: 1 })).toHaveLength(1)
  })

  it('a picture or shape placed in pixels is refused when rows of its sheet moved', () => {
    refused({ op: 'insert_shape', sheet: 'S', geometry: 'rect', x: 10, y: 300, width: 50, height: 20 }, insertRows('S', 0), /place it again/)
    expect(transform({ op: 'delete_drawing', sheet: 'S', id: '3' }, insertRows('S', 0))).toHaveLength(1)
  })
})

describe('rebasing a batch with a refusal', () => {
  it('the refused change and every change after it are refused, with why; before it stands', () => {
    const body = (op: SheetOp): LogBody => ({ kind: 'change', ops: [op], acceptLosses: false })
    const items = [
      { opId: 'a', body: body(write('S', 'A20')) },
      { opId: 'b', body: body(write('S', 'B3')) },
      { opId: 'c', body: body(write('S', 'Z1')) },
    ]
    const { kept, refused: no } = rebaseItems(items, [body({ op: 'sort_range', sheet: 'S', range: 'A1:C9', keys: [{ col: 0 }] })])
    expect(kept.map((k) => k.opId)).toEqual(['a'])
    expect(no.map((r) => [r.item.opId, r.reason])).toEqual([
      ['b', expect.stringMatching(/was sorted/)],
      ['c', expect.stringMatching(/came after one of your changes/)],
    ])
  })
})
