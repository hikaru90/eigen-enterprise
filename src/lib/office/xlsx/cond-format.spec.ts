import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { dateToSerial } from './calc'
import { cfEvaluator, cfRulesOf, inputOf, TIME_PERIODS, type CfRuleInput } from './cond-format'
import { createSheetEditor } from './editor'
import { buildXlsx, fml, num, row, str } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

const parts = (b: Uint8Array) => unzipSync(b)
const sheetXml = (b: Uint8Array, n = 1) => strFromU8(parts(b)[`xl/worksheets/sheet${n}.xml`]!)
const stylesXml = (b: Uint8Array) => strFromU8(parts(b)['xl/styles.xml']!)

function evalSheet(bytes: Uint8Array, sheet = 'S') {
  const ed = createSheetEditor(bytes)
  return { ed, look: cfEvaluator(ed.wb, ed.calc(), sheet) }
}

function addAndReopen(
  bytes: Uint8Array,
  sheet: string,
  rules: Array<{ range: string; rule: CfRuleInput }>,
) {
  const ed = createSheetEditor(bytes)
  for (const { range, rule } of rules) ed.apply({ op: 'cf_add', sheet, range, rule })
  const out = ed.toBytes()
  return { out, ed2: createSheetEditor(out) }
}

describe('conditional formatting: cellIs, expression, priority, stopIfTrue and dxf', () => {
  it('evaluates all cellIs operators and round-trips dxf styles', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows:
            row(1, num('A1', 5) + num('B1', 10) + num('C1', 15) + num('D1', 20)) +
            row(2, num('A2', 10) + fml('B2', '1/0', '#DIV/0!')),
        },
      ],
    })
    const { out, ed2 } = addAndReopen(bytes, 'S', [
      {
        range: 'A1:D1',
        rule: {
          type: 'cellIs',
          operator: 'between',
          formula1: '10',
          formula2: '15',
          style: { fill: '#C6EFCE', fontColor: '#006100', bold: true },
        },
      },
      {
        range: 'A1:D1',
        rule: {
          type: 'cellIs',
          operator: 'notBetween',
          formula1: '10',
          formula2: '15',
          style: { italic: true },
        },
      },
      {
        range: 'A1:D1',
        rule: {
          type: 'cellIs',
          operator: 'greaterThan',
          formula1: '=$A$2',
          style: { underline: true, strike: true, border: '#FF0000', numFmt: '0.00' },
        },
      },
    ])
    const look = cfEvaluator(ed2.wb, ed2.calc(), 'S')
    expect(look(0, 0)).toMatchObject({ italic: true })
    expect(look(0, 1)).toMatchObject({ fill: '#C6EFCE', fontColor: '#006100', bold: true })
    expect(look(0, 2)).toMatchObject({
      fill: '#C6EFCE',
      bold: true,
      underline: true,
      strike: true,
      border: '#FF0000',
      numFmt: '0.00',
    })
    expect(look(0, 3)).toMatchObject({ italic: true, underline: true })
    // Error cells never match cellIs.
    expect(look(1, 1)).toBeNull()
    expect(stylesXml(out)).toContain('<dxfs count="3">')
    expect(cfRulesOf(ed2.wb, 'S')).toHaveLength(3)

    // Remaining operators: equal, notEqual, lessThan, greaterThanOrEqual, lessThanOrEqual.
    for (const [op, f1, expected] of [
      ['equal', '10', [false, true, false, false]],
      ['notEqual', '10', [true, false, true, true]],
      ['lessThan', '15', [true, true, false, false]],
      ['greaterThanOrEqual', '15', [false, false, true, true]],
      ['lessThanOrEqual', '10', [true, true, false, false]],
    ] as const) {
      const ed = createSheetEditor(bytes)
      ed.apply({
        op: 'cf_add',
        sheet: 'S',
        range: 'A1:D1',
        rule: { type: 'cellIs', operator: op, formula1: f1, style: { bold: true } },
      })
      const fn = cfEvaluator(ed.wb, ed.calc(), 'S')
      expect([0, 1, 2, 3].map((c) => !!fn(0, c)?.bold)).toEqual(expected)
    }
  })

  it('evaluates expression rules relative to the range anchor via calc and honours priority + stopIfTrue', () => {
    const bytes = buildXlsx({
      strings: ['Paid', 'Open'],
      sheets: [
        {
          name: 'S',
          rows:
            row(1, str('A1', 0) + num('B1', 50)) +
            row(2, str('A2', 1) + num('B2', 200)) +
            row(3, str('A3', 0) + num('B3', 200)),
        },
      ],
    })
    const ed = createSheetEditor(bytes)
    // Added second -> priority 1 (higher); Stop If True stops lower rule on A3/B3.
    ed.apply({
      op: 'cf_add',
      sheet: 'S',
      range: 'A1:B3',
      rule: {
        type: 'expression',
        formula1: '=$B1>100',
        style: { fill: '#FFEB9C', bold: true },
      },
    })
    ed.apply({
      op: 'cf_add',
      sheet: 'S',
      range: 'A1:B3',
      rule: {
        type: 'expression',
        formula1: '=$A1="Paid"',
        style: { fill: '#C6EFCE', italic: true },
        stopIfTrue: true,
      },
    })
    const out = ed.toBytes()
    const { look } = evalSheet(out, 'S')
    // Row 1: Paid -> priority 1 matches, stopIfTrue stops priority 2.
    expect(look(0, 0)).toEqual({ fill: '#C6EFCE', italic: true })
    // Row 2: Open, 200 -> priority 1 misses, priority 2 matches.
    expect(look(1, 0)).toEqual({ fill: '#FFEB9C', bold: true })
    // Row 3: Paid, 200 -> priority 1 matches and stopIfTrue prevents priority 2's bold/fill.
    expect(look(2, 0)).toEqual({ fill: '#C6EFCE', italic: true })
    expect(look(2, 1)).toEqual({ fill: '#C6EFCE', italic: true })

    // Clear stopIfTrue on priority 1: both apply, priority 1 fill wins, priority 2 bold merges.
    const ed2 = createSheetEditor(out)
    const r1 = cfRulesOf(ed2.wb, 'S')[0]!
    ed2.apply({
      op: 'cf_update',
      sheet: 'S',
      priority: 1,
      rule: { ...inputOf(r1), stopIfTrue: false },
    })
    const look2 = cfEvaluator(ed2.wb, ed2.calc(), 'S')
    expect(look2(2, 0)).toEqual({ fill: '#C6EFCE', italic: true, bold: true })
  })
})

describe('conditional formatting: colour scales, data bars and icon sets', () => {
  it('evaluates 2-point and 3-point colour scales and round-trips XML', () => {
    const bytes = buildXlsx({
      sheets: [
        { name: 'S', rows: row(1, num('A1', 0)) + row(2, num('A2', 50)) + row(3, num('A3', 100)) },
      ],
    })
    const { ed2: ed2pt } = addAndReopen(bytes, 'S', [
      {
        range: 'A1:A3',
        rule: {
          type: 'colorScale',
          points: [
            { kind: 'min', color: '#FF0000' },
            { kind: 'max', color: '#0000FF' },
          ],
        },
      },
    ])
    const look2 = cfEvaluator(ed2pt.wb, ed2pt.calc(), 'S')
    expect(look2(0, 0)?.fill).toBe('#FF0000')
    expect(look2(1, 0)?.fill).toBe('#800080')
    expect(look2(2, 0)?.fill).toBe('#0000FF')

    const { ed2: ed3pt } = addAndReopen(bytes, 'S', [
      {
        range: 'A1:A3',
        rule: {
          type: 'colorScale',
          points: [
            { kind: 'num', value: '0', color: '#F8696B' },
            { kind: 'percentile', value: '50', color: '#FFEB84' },
            { kind: 'percent', value: '100', color: '#63BE7B' },
          ],
        },
      },
    ])
    const look3 = cfEvaluator(ed3pt.wb, ed3pt.calc(), 'S')
    expect(look3(0, 0)?.fill).toBe('#F8696B')
    expect(look3(1, 0)?.fill).toBe('#FFEB84')
    expect(look3(2, 0)?.fill).toBe('#63BE7B')
  })

  it('evaluates data bars with x14 extension (negative values, solid fill, border, middle/automatic axis) and round-trips XML', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: row(1, num('A1', -20)) + row(2, num('A2', 0)) + row(3, num('A3', 60)),
        },
      ],
    })
    const { out, ed2 } = addAndReopen(bytes, 'S', [
      {
        range: 'A1:A3',
        rule: {
          type: 'dataBar',
          bar: {
            color: '#638EC6',
            negativeColor: '#FF5555',
            gradient: false,
            border: true,
            showValue: false,
            axis: 'automatic',
          },
        },
      },
    ])
    const xml = sheetXml(out)
    expect(xml).toContain('x14:dataBar')
    expect(xml).toContain('x14:id')
    expect(xml).toContain('gradient="0"')
    const rules = cfRulesOf(ed2.wb, 'S')
    expect(rules).toHaveLength(1)
    expect(rules[0]!.dataBar).toMatchObject({
      color: '#638EC6',
      negativeColor: '#FF5555',
      gradient: false,
      showValue: false,
      border: '#638EC6',
      axis: 'automatic',
    })
    const look = cfEvaluator(ed2.wb, ed2.calc(), 'S')
    // Range [-20, 60] => axis at 25%.
    expect(look(0, 0)).toMatchObject({
      hideValue: true,
      bar: { from: 0, to: 25, color: '#FF5555', negative: true, axis: 25, gradient: false },
    })
    expect(look(1, 0)?.bar).toMatchObject({ from: 25, to: 25, negative: false, axis: 25 })
    expect(look(2, 0)?.bar).toMatchObject({
      from: 25,
      to: 100,
      color: '#638EC6',
      negative: false,
      axis: 25,
    })

    // Middle axis
    const { ed2: midEd } = addAndReopen(bytes, 'S', [
      {
        range: 'A1:A3',
        rule: {
          type: 'dataBar',
          bar: { color: '#00AA00', negativeColor: '#AA0000', axis: 'middle' },
        },
      },
    ])
    const midLook = cfEvaluator(midEd.wb, midEd.calc(), 'S')
    expect(midLook(0, 0)?.bar).toMatchObject({ from: 0, to: 50, negative: true, axis: 50 })
    expect(midLook(2, 0)?.bar).toMatchObject({ from: 50, to: 100, negative: false, axis: 50 })
  })

  it('evaluates standard, x14-only and x14 custom icon sets and round-trips XML', () => {
    const bytes = buildXlsx({
      sheets: [
        { name: 'S', rows: row(1, num('A1', 10)) + row(2, num('A2', 50)) + row(3, num('A3', 90)) },
      ],
    })
    const { ed2 } = addAndReopen(bytes, 'S', [
      {
        range: 'A1:A3',
        rule: {
          type: 'iconSet',
          icons: { set: '3Arrows', reverse: true, showValue: false },
        },
      },
    ])
    const look = cfEvaluator(ed2.wb, ed2.calc(), 'S')
    expect(look(0, 0)).toMatchObject({ icon: { set: '3Arrows', index: 2 }, hideValue: true })
    expect(look(1, 0)).toMatchObject({ icon: { set: '3Arrows', index: 1 }, hideValue: true })
    expect(look(2, 0)).toMatchObject({ icon: { set: '3Arrows', index: 0 }, hideValue: true })

    // x14-only set (3Stars) + custom icons (including NoIcons)
    const { out: x14Out, ed2: x14Ed } = addAndReopen(bytes, 'S', [
      {
        range: 'A1:A3',
        rule: {
          type: 'iconSet',
          icons: {
            set: '3Stars',
            thresholds: [
              { kind: 'num', value: '40', gte: true },
              { kind: 'num', value: '80', gte: false },
            ],
            custom: [
              { set: 'NoIcons', index: 0 },
              { set: '3Flags', index: 1 },
              { set: '3Stars', index: 2 },
            ],
          },
        },
      },
    ])
    const xml = sheetXml(x14Out)
    expect(xml).toContain('x14:iconSet')
    expect(xml).toContain('custom="1"')
    expect(xml).toContain('x14:cfIcon')
    const parsed = cfRulesOf(x14Ed.wb, 'S')[0]!
    expect(parsed.extension).toBe(true)
    expect(inputOf(parsed)).toMatchObject({
      type: 'iconSet',
      icons: {
        set: '3Stars',
        custom: [
          { set: 'NoIcons', index: 0 },
          { set: '3Flags', index: 1 },
          { set: '3Stars', index: 2 },
        ],
      },
    })
    const x14Look = cfEvaluator(x14Ed.wb, x14Ed.calc(), 'S')
    expect(x14Look(0, 0)?.icon).toBeUndefined()
    expect(x14Look(1, 0)?.icon).toEqual({ set: '3Flags', index: 1 })
    expect(x14Look(2, 0)?.icon).toEqual({ set: '3Stars', index: 2 })
  })
})

describe('conditional formatting: top/bottom, above/below average, duplicates, text, blanks, errors and time periods', () => {
  it('evaluates top10 (count and percent, top and bottom) and aboveAverage (with stdDev and equalAverage)', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: [10, 20, 30, 40, 50].map((v, i) => row(i + 1, num(`A${i + 1}`, v))).join(''),
        },
      ],
    })
    const { ed2 } = addAndReopen(bytes, 'S', [
      { range: 'A1:A5', rule: { type: 'top10', rank: 2, style: { bold: true } } },
      {
        range: 'A1:A5',
        rule: { type: 'top10', rank: 25, percent: true, bottom: true, style: { italic: true } },
      },
      {
        range: 'A1:A5',
        rule: { type: 'aboveAverage', equalAverage: true, style: { underline: true } },
      },
      {
        range: 'A1:A5',
        rule: { type: 'aboveAverage', below: true, stdDev: 1, style: { strike: true } },
      },
    ])
    const look = cfEvaluator(ed2.wb, ed2.calc(), 'S')
    // Mean=30, sample SD=sqrt(250)=15.81, below 1 SD => < 14.19 (only 10).
    expect(look(0, 0)).toMatchObject({ italic: true, strike: true })
    expect(look(1, 0)).toBeNull()
    expect(look(2, 0)).toMatchObject({ underline: true })
    expect(look(3, 0)).toMatchObject({ bold: true, underline: true })
    expect(look(4, 0)).toMatchObject({ bold: true, underline: true })
  })

  it('evaluates duplicateValues, uniqueValues, text rules, blanks and errors', () => {
    const bytes = buildXlsx({
      strings: ['Apple', 'apple', 'Banana', 'Cherry pie', '  '],
      sheets: [
        {
          name: 'S',
          rows:
            row(1, str('A1', 0) + str('B1', 1)) +
            row(2, str('A2', 2) + str('B2', 3)) +
            row(3, str('A3', 4) + fml('B3', '1/0', '#DIV/0!')),
        },
      ],
    })
    const { ed2 } = addAndReopen(bytes, 'S', [
      { range: 'A1:B2', rule: { type: 'duplicateValues', style: { fill: '#FFC7CE' } } },
      { range: 'A1:B2', rule: { type: 'uniqueValues', style: { fontColor: '#006100' } } },
      { range: 'A1:B3', rule: { type: 'containsText', text: 'pie', style: { bold: true } } },
      { range: 'A1:B2', rule: { type: 'beginsWith', text: 'ban', style: { italic: true } } },
      { range: 'A1:B2', rule: { type: 'endsWith', text: 'ana', style: { underline: true } } },
      { range: 'A3:B3', rule: { type: 'containsBlanks', style: { fill: '#EEEEEE' } } },
      { range: 'A3:B3', rule: { type: 'containsErrors', style: { fontColor: '#FF0000' } } },
    ])
    const look = cfEvaluator(ed2.wb, ed2.calc(), 'S')
    expect(look(0, 0)).toMatchObject({ fill: '#FFC7CE' })
    expect(look(0, 1)).toMatchObject({ fill: '#FFC7CE' })
    expect(look(1, 0)).toMatchObject({ fontColor: '#006100', italic: true, underline: true })
    expect(look(1, 1)).toMatchObject({ fontColor: '#006100', bold: true })
    expect(look(2, 0)).toMatchObject({ fill: '#EEEEEE' })
    expect(look(2, 1)).toMatchObject({ fontColor: '#FF0000' })

    // notContainsText, notContainsBlanks, notContainsErrors
    const { ed2: neg } = addAndReopen(bytes, 'S', [
      { range: 'A2:B2', rule: { type: 'notContainsText', text: 'pie', style: { bold: true } } },
      { range: 'A2:A3', rule: { type: 'notContainsBlanks', style: { italic: true } } },
      { range: 'A1:A1', rule: { type: 'notContainsErrors', style: { underline: true } } },
    ])
    const nLook = cfEvaluator(neg.wb, neg.calc(), 'S')
    expect(nLook(1, 0)?.bold).toBe(true)
    expect(nLook(1, 1)?.bold).toBeUndefined()
    expect(nLook(2, 0)?.italic).toBeUndefined()
    expect(nLook(1, 0)?.italic).toBe(true)
    expect(nLook(0, 0)?.underline).toBe(true)
  })

  it('evaluates all 10 timePeriod rules and round-trips XML', () => {
    const now = new Date()
    const today = Math.floor(
      dateToSerial(new Date(now.getFullYear(), now.getMonth(), now.getDate())),
    )
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: row(1, num('A1', today) + num('B1', today - 1) + num('C1', today + 1)),
        },
      ],
    })
    for (const period of TIME_PERIODS) {
      const { ed2 } = addAndReopen(bytes, 'S', [
        { range: 'A1:C1', rule: { type: 'timePeriod', period, style: { bold: true } } },
      ])
      expect(cfRulesOf(ed2.wb, 'S')[0]!.period).toBe(period)
      const look = cfEvaluator(ed2.wb, ed2.calc(), 'S')
      if (period === 'today') {
        expect(look(0, 0)?.bold).toBe(true)
        expect(look(0, 1)?.bold).toBeUndefined()
      } else if (period === 'yesterday') {
        expect(look(0, 1)?.bold).toBe(true)
      } else if (period === 'tomorrow') {
        expect(look(0, 2)?.bold).toBe(true)
      } else if (period === 'last7Days') {
        expect(look(0, 0)?.bold).toBe(true)
        expect(look(0, 1)?.bold).toBe(true)
        expect(look(0, 2)?.bold).toBeUndefined()
      }
    }
  })
})

describe('conditional formatting: reorder, update, delete, partial clear and structure moves', () => {
  it('reorders, updates, deletes, clears partially (sqref subtraction) and moves with rows; untouched parts stay byte for byte', () => {
    const bytes = buildXlsx({
      sheets: [{ name: 'S', rows: row(1, num('A1', 10)) + row(2, num('A2', 20)) }],
    })
    const ed = createSheetEditor(bytes)
    ed.apply({
      op: 'cf_add',
      sheet: 'S',
      range: 'A1:B4',
      rule: { type: 'cellIs', operator: 'greaterThan', formula1: '5', style: { fill: '#111111' } },
    })
    ed.apply({
      op: 'cf_add',
      sheet: 'S',
      range: 'A1:B4',
      rule: { type: 'expression', formula1: '=A1>0', style: { fill: '#222222' } },
    })
    expect(cfRulesOf(ed.wb, 'S').map((r) => [r.priority, r.type])).toEqual([
      [1, 'expression'],
      [2, 'cellIs'],
    ])
    // Move rule 2 to priority 1.
    ed.apply({ op: 'cf_move', sheet: 'S', priority: 2, to: 1 })
    expect(cfRulesOf(ed.wb, 'S').map((r) => [r.priority, r.type])).toEqual([
      [1, 'cellIs'],
      [2, 'expression'],
    ])
    // Clear A1:A1 from all rules -> range splits via sqref subtraction and formula re-anchors!
    ed.apply({ op: 'cf_clear', sheet: 'S', range: 'A1' })
    const afterClear = cfRulesOf(ed.wb, 'S')
    expect(afterClear[0]!.sqref).toBe('A2:B4 B1')
    expect(afterClear[1]!.formulas[0]).toBe('=A2>0')
    // Delete priority 1 -> remaining rule renumbers to 1.
    ed.apply({ op: 'cf_delete', sheet: 'S', priority: 1 })
    expect(cfRulesOf(ed.wb, 'S').map((r) => r.priority)).toEqual([1])
    // Insert a row at top -> sqref and formula move.
    ed.apply({ op: 'insert_rows', sheet: 'S', at: 0, count: 1 })
    const moved = cfRulesOf(ed.wb, 'S')[0]!
    expect(moved.sqref).toBe('A3:B5 B2')
    expect(moved.formulas[0]).toBe('=A3>0')
    const out = ed.toBytes()
    expect(parts(out)['xl/theme/theme1.xml']).toEqual(parts(bytes)['xl/theme/theme1.xml'])
    expect(openWorkbook(out).sheet('S').cells.size).toBe(2)
  })
})
