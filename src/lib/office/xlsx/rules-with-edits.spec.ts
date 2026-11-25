import type { SheetOp } from './ops'
import { describe, expect, it } from 'vitest'
import { readClip } from './clip'
import { cfRulesOf } from './cond-format'
import { createSheetEditor } from './editor'
import { requireRange } from './ref'
import { buildXlsx, num, row } from './test-utils/build-xlsx'
import { validationsOf } from './validation'

/**
 * Protection, conditional formats and validations together with the other
 * streams' operations (charts, tables, PivotTables, everyday editing): what
 * a protected sheet or workbook refuses, and how rules travel with sorted,
 * pasted, cut and filled cells — as Excel does.
 */

const book = () =>
  buildXlsx({
    sheets: [
      {
        name: 'S',
        rows:
          row(1, num('A1', 3) + num('B1', 30)) +
          row(2, num('A2', 1) + num('B2', 10)) +
          row(3, num('A3', 2) + num('B3', 20)),
      },
      { name: 'T' },
    ],
  })

const red = { fill: '#FFC7CE' }
const op = (o: unknown) => o as SheetOp
/** The message an operation fails with (it must fail). */
const failure = (run: () => unknown) => {
  try {
    run()
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected the operation to fail')
}

describe('protection covers charts, tables, PivotTables and everyday editing', () => {
  it('a protected sheet refuses tables always, charts unless objects are allowed, PivotTables unless allowed', () => {
    const ed = createSheetEditor(book())
    ed.apply({ op: 'protect_sheet', sheet: 'S' })
    expect(() => ed.apply(op({ op: 'create_table', sheet: 'S', range: 'A1:B3' }))).toThrow(
      /protected: you can’t make tables/,
    )
    expect(() => ed.apply(op({ op: 'chart_delete', sheet: 'S', chart: 'c1' }))).toThrow(
      /protected: you can’t delete charts/,
    )
    expect(() => ed.apply(op({ op: 'update_pivot', sheet: 'S', pivot: 'P' }))).toThrow(
      /protected: you can’t change PivotTables/,
    )
    expect(() =>
      ed.apply(op({ op: 'create_pivot', source: 'S!A1:B3', targetSheet: 'S', targetCell: 'D1' })),
    ).toThrow(/protected: you can’t put PivotTables/)
    // With "Edit objects" and "Use PivotTable" allowed, the guard lets them through (what follows is the op's own check).
    ed.apply({ op: 'unprotect_sheet', sheet: 'S' })
    ed.apply({ op: 'protect_sheet', sheet: 'S', allow: { objects: true, pivotTables: true } })
    expect(
      failure(() => ed.apply(op({ op: 'chart_delete', sheet: 'S', chart: 'c1' }))),
    ).not.toMatch(/protected/)
    expect(failure(() => ed.apply(op({ op: 'update_pivot', sheet: 'S', pivot: 'P' })))).not.toMatch(
      /protected/,
    )
  })

  it('a protected sheet refuses pasting, filling, clearing and replacing locked cells, and merging', () => {
    const ed = createSheetEditor(book())
    ed.apply({ op: 'set_cell_protection', sheet: 'S', range: 'B1:B5', locked: false })
    ed.apply({ op: 'protect_sheet', sheet: 'S' })
    const clip = readClip(ed, 'S', requireRange('A1'), null)
    expect(() => ed.apply(op({ op: 'paste', sheet: 'S', at: 'A3', clip }))).toThrow(
      /S!A3 is locked/,
    )
    // Values only: Paste All would copy A1's (locked) format onto B3, as in Excel.
    ed.apply(op({ op: 'paste', sheet: 'S', at: 'B3', paste: 'values', clip }))
    expect(() => ed.apply(op({ op: 'fill', sheet: 'S', source: 'A1', target: 'A1:A4' }))).toThrow(
      /S!A2 is locked/,
    )
    ed.apply(op({ op: 'fill', sheet: 'S', source: 'B1', target: 'B1:B4' }))
    expect(() =>
      ed.apply(op({ op: 'clear_range', sheet: 'S', range: 'A2', what: 'contents' })),
    ).toThrow(/locked/)
    expect(() =>
      ed.apply(op({ op: 'replace', sheet: 'S', find: '1', replace: '9', wholeCell: true })),
    ).toThrow(/S!A2 is locked .* can’t be replaced/)
    expect(() =>
      ed.apply(op({ op: 'merge_cells', sheet: 'S', range: 'B1:B2', mode: 'merge' })),
    ).toThrow(/merge or unmerge/)
    // A cut takes cells from its source: locked source cells refuse it.
    const cut = readClip(ed, 'S', requireRange('A1'), null)
    expect(() => ed.apply(op({ op: 'paste', sheet: 'S', at: 'B5', clip: cut, cut: true }))).toThrow(
      /S!A1 is locked/,
    )
  })

  it('a locked workbook structure refuses moving, colouring, hiding and duplicating tabs, and new sheets for charts and PivotTables', () => {
    const ed = createSheetEditor(book())
    ed.apply({ op: 'protect_workbook' })
    for (const o of [
      { op: 'move_sheet', sheet: 'T', to: 0 },
      { op: 'set_sheet_color', sheet: 'T', color: '#FF0000' },
      { op: 'set_sheet_visibility', sheet: 'T', state: 'hidden' },
      { op: 'duplicate_sheet', sheet: 'T' },
      { op: 'chart_create', sheet: 'S', newSheet: 'Chart1' },
      { op: 'create_pivot', source: 'S!A1:B3' },
    ])
      expect(() => ed.apply(op(o))).toThrow(/structure is protected/)
  })
})

describe('conditional formats and validations travel with the cells', () => {
  it('sort moves a rule on some sorted rows with its cells; a rule over the whole column stays', () => {
    const ed = createSheetEditor(book())
    ed.apply({
      op: 'cf_add',
      sheet: 'S',
      range: 'B2',
      rule: { type: 'cellIs', operator: 'greaterThan', formula1: '0', style: red },
    })
    ed.apply({
      op: 'cf_add',
      sheet: 'S',
      range: 'A1:A3',
      rule: { type: 'duplicateValues', style: red },
    })
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'B2',
      rule: { type: 'whole', operator: 'greaterThan', formula1: '0' },
    })
    // Ascending by A: rows 3,1,2 → row 2 (A=1) goes to the top.
    ed.apply({
      op: 'sort_range',
      sheet: 'S',
      range: 'A1:B3',
      header: false,
      keys: [{ col: 0, descending: false }],
    })
    const rules = cfRulesOf(ed.wb, 'S')
    expect(rules.find((r) => r.type === 'cellIs')!.sqref).toBe('B1')
    expect(rules.find((r) => r.type === 'duplicateValues')!.sqref).toBe('A1:A3')
    expect(validationsOf(ed.wb, 'S')[0]!.sqref).toBe('B1')
  })

  it('paste (all) brings the source’s rules and validations; Paste Formats only the rules; relative formulas follow', () => {
    const ed = createSheetEditor(book())
    ed.apply({
      op: 'cf_add',
      sheet: 'S',
      range: 'A1:A3',
      rule: { type: 'expression', formula1: '=A1>B1', style: red },
    })
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'A1',
      rule: { type: 'list', items: ['1', '3'] },
    })
    ed.apply(
      op({ op: 'paste', sheet: 'T', at: 'C5', clip: readClip(ed, 'S', requireRange('A1'), null) }),
    )
    const t = cfRulesOf(ed.wb, 'T')
    expect(t.map((r) => [r.sqref, r.formulas[0]])).toEqual([['C5', '=C5>D5']])
    expect(validationsOf(ed.wb, 'T').map((v) => [v.sqref, v.items])).toEqual([['C5', ['1', '3']]])
    ed.apply(
      op({
        op: 'paste',
        sheet: 'T',
        at: 'E1',
        paste: 'formats',
        clip: readClip(ed, 'S', requireRange('A1'), null),
      }),
    )
    expect(
      cfRulesOf(ed.wb, 'T')
        .map((r) => r.sqref)
        .sort(),
    ).toEqual(['C5', 'E1'])
    expect(validationsOf(ed.wb, 'T').map((v) => v.sqref)).toEqual(['C5'])
    // Pasting plain cells over a rule's cells takes the rule off them (pasting is formatting).
    ed.apply(
      op({ op: 'paste', sheet: 'T', at: 'C5', clip: readClip(ed, 'S', requireRange('B1'), null) }),
    )
    expect(cfRulesOf(ed.wb, 'T').map((r) => r.sqref)).toEqual(['E1'])
  })

  it('cut moves the rules: the source cells lose them', () => {
    const ed = createSheetEditor(book())
    ed.apply({
      op: 'cf_add',
      sheet: 'S',
      range: 'A1:A3',
      rule: { type: 'duplicateValues', style: red },
    })
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'A1:A3',
      rule: { type: 'whole', operator: 'greaterThan', formula1: '0' },
    })
    ed.apply(
      op({
        op: 'paste',
        sheet: 'S',
        at: 'D1',
        cut: true,
        clip: readClip(ed, 'S', requireRange('A1:A3'), null),
      }),
    )
    expect(cfRulesOf(ed.wb, 'S').map((r) => r.sqref)).toEqual(['D1:D3'])
    expect(validationsOf(ed.wb, 'S').map((v) => v.sqref)).toEqual(['D1:D3'])
  })

  it('fill repeats the source block’s rules over the filled cells', () => {
    const ed = createSheetEditor(book())
    ed.apply({
      op: 'cf_add',
      sheet: 'S',
      range: 'B1',
      rule: { type: 'cellIs', operator: 'greaterThan', formula1: '=A1', style: red },
    })
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'B1',
      rule: { type: 'decimal', operator: 'greaterThan', formula1: '0' },
    })
    ed.apply(op({ op: 'fill', sheet: 'S', source: 'B1', target: 'B1:B4' }))
    const rules = cfRulesOf(ed.wb, 'S')
    expect(rules.map((r) => r.sqref).sort()).toEqual(['B1', 'B2:B4'])
    expect(rules.find((r) => r.sqref === 'B2:B4')!.formulas).toEqual(['=A2'])
    expect(
      validationsOf(ed.wb, 'S')
        .map((v) => v.sqref)
        .sort(),
    ).toEqual(['B1', 'B2:B4'])
  })
})
