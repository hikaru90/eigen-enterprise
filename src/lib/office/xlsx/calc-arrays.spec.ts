import { describe, expect, it } from 'vitest'
import { createCalc } from './calc'
import { createSheetEditor } from './editor'
import { buildXlsx, cse, daParts, dyn, fml, num, row, txt } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

const e = (code: string) => ({ error: code })
const ok = (value: unknown) => ({ value, kept: false })

describe('xlsx calc: dynamic arrays spill', () => {
  const spillBook = () =>
    buildXlsx({
      ...daParts(),
      sheets: [
        {
          name: 'S',
          rows:
            row(
              1,
              num('A1', 3) +
                dyn('C1', 'C1:C3', '_xlfn._xlws.SORT(A1:A3)', 1) +
                dyn('E1', 'E1:E2', '_xlfn.SEQUENCE(4)', 1) +
                dyn('G1', 'G1', '_xlfn.SEQUENCE(3)', 1) +
                dyn('I1', 'I1:I5', '_xlfn._xlws.FILTER(A1:A3,A1:A3>1)', 3) +
                fml('K1', 'SUM(_xlfn.ANCHORARRAY(C1))', 0) +
                dyn('M1', 'M1:M2', '_xlfn.SEQUENCE(2)+M2', 0),
            ) +
            row(
              2,
              num('A2', 1) +
                num('C2', 2) +
                num('E2', 2) +
                txt('G2', 'in the way') +
                num('I2', 2) +
                fml('K2', 'C3*10', 0) +
                num('M2', 0),
            ) +
            row(3, num('A3', 2) + num('C3', 3) + num('I3', 9) + fml('K3', 'SUM(C1#)', 0)) +
            row(4, num('I4', 9)) +
            row(5, num('I5', 9)),
        },
      ],
    })

  it('reads the anchor and its spilled cells from a recalculation, not the cached ones', () => {
    const calc = createCalc(openWorkbook(spillBook()))
    expect(calc.cell('S', 0, 2)).toEqual(ok(1))
    expect(calc.cell('S', 1, 2)).toEqual(ok(2))
    expect(calc.cell('S', 2, 2)).toEqual(ok(3))
    expect(calc.spill('S', 0, 2)).toEqual({ range: 'C1:C3', values: [[1], [2], [3]] })
  })

  it('a spill grows past the range Excel last wrote, and shrinks out of it', () => {
    const calc = createCalc(openWorkbook(spillBook()))
    expect([0, 1, 2, 3].map((r) => calc.cell('S', r, 4).value)).toEqual([1, 2, 3, 4])
    expect(calc.cell('S', 4, 4)).toEqual(ok(null))
    // FILTER now has two results: I3:I5 held Excel's old spill and are empty.
    expect([0, 1, 2, 3, 4].map((r) => calc.cell('S', r, 8).value)).toEqual([3, 2, null, null, null])
  })

  it('a spill blocked by a value is #SPILL!, the value stays', () => {
    const calc = createCalc(openWorkbook(spillBook()))
    expect(calc.cell('S', 0, 6)).toEqual(ok(e('#SPILL!')))
    expect(calc.cell('S', 1, 6)).toEqual(ok('in the way'))
    expect(calc.spill('S', 0, 6)).toEqual({ range: 'G1', values: [[e('#SPILL!')]] })
  })

  it('formulas read spilled cells and whole spills (A1#)', () => {
    const calc = createCalc(openWorkbook(spillBook()))
    expect(calc.cell('S', 0, 10)).toEqual(ok(6))
    expect(calc.cell('S', 1, 10)).toEqual(ok(30))
    expect(calc.cell('S', 2, 10)).toEqual(ok(6))
  })

  it('a spill that reads its own spill range is a circular reference', () => {
    const calc = createCalc(openWorkbook(spillBook()))
    expect(calc.cell('S', 0, 12)).toMatchObject({
      kept: true,
      reason: expect.stringMatching(/circular/),
    })
  })

  it('follows a change of what it reads', () => {
    const ed = createSheetEditor(spillBook())
    ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'A1', value: 0 }] })
    const calc = ed.calc()
    expect([0, 1, 2].map((r) => calc.cell('S', r, 2).value)).toEqual([0, 1, 2])
    expect(calc.cell('S', 0, 10).value).toBe(3)
  })
})

describe('xlsx calc: legacy array (Ctrl+Shift+Enter) formulas', () => {
  const book = () =>
    buildXlsx({
      sheets: [
        {
          name: 'S',
          rows:
            row(
              1,
              num('A1', 1) +
                num('B1', 4) +
                cse('C1', 'C1:C3', 'A1:A3*B1:B3', 0) +
                cse('D1', 'D1', 'SUM(A1:A3*B1:B3)', 0) +
                cse('E1', 'E1:E4', 'A1:A3', 0) +
                cse('F1', 'F1:G2', '5', 0),
            ) +
            row(2, num('A2', 2) + num('B2', 5) + num('C2', 0) + num('E2', 0) + num('F2', 0)) +
            row(3, num('A3', 3) + num('B3', 6) + num('C3', 0) + num('E3', 0)) +
            row(4, num('E4', 0)),
        },
      ],
    })

  it('calculates the whole range once and fills it the way Excel does', () => {
    const calc = createCalc(openWorkbook(book()))
    expect([0, 1, 2].map((r) => calc.cell('S', r, 2).value)).toEqual([4, 10, 18])
    expect(calc.cell('S', 0, 3)).toEqual(ok(32))
    // A range larger than the result: the extra cells are #N/A.
    expect([0, 1, 2, 3].map((r) => calc.cell('S', r, 4).value)).toEqual([1, 2, 3, e('#N/A')])
    // A single value fills the range.
    expect(calc.cell('S', 1, 6)).toEqual(ok(5))
  })
})

describe('xlsx calc: single-cell formulas from older files use implicit intersection', () => {
  const book = () =>
    buildXlsx({
      sheets: [
        {
          name: 'S',
          rows:
            row(1, num('A1', 1) + num('B1', 4) + fml('H1', 'SUMPRODUCT((A1:A3>1)*B1:B3)', 0)) +
            row(2, num('A2', 2) + num('B2', 5) + fml('H2', 'A1:A3*2', 0) + fml('I2', 'A1:A3', 0)) +
            row(3, num('A3', 3) + num('B3', 6) + fml('H3', 'SUM(A1:A3*2)', 0)) +
            row(
              5,
              fml('H5', 'A1:A3*2', 0) +
                fml('I5', 'SUM(A1:A3)', 0) +
                fml('J5', 'ROW(A1:A3)', 0) +
                fml('K5', '_xlfn._xlws.SORT(A1:A3)', 0) +
                fml('L5', '{7,8,9}', 0) +
                fml('M5', 'SUM(ROW(A1:A3))', 0) +
                fml('N5', 'ABS(A1:A3)', 0) +
                fml('O5', 'LOOKUP(2,1/(A1:A3>1),B1:B3)', 0),
            ) +
            row(6, fml('A6', 'A1:C1', 0) + fml('B6', 'A1:C1+1', 0)),
        },
      ],
    })

  it.each([
    ['H1', 11],
    ['H2', 4],
    ['I2', 2],
    ['H3', 6],
    ['H5', e('#VALUE!')],
    ['I5', 6],
    ['J5', 1],
    ['K5', 1],
    ['L5', 7],
    ['M5', 1],
    ['N5', e('#VALUE!')],
    ['O5', 6],
    ['A6', 1],
    ['B6', 5],
  ])('%s → %j', (ref, value) => {
    const calc = createCalc(openWorkbook(book()))
    const m = /^([A-Z])(\d+)$/.exec(ref)!
    const out = calc.cell('S', Number(m[2]) - 1, m[1]!.charCodeAt(0) - 65)
    expect(out).toEqual(ok(value))
  })
})

describe('xlsx calc: circular references', () => {
  const book = (calcPr?: string) =>
    buildXlsx({
      calcPr,
      sheets: [
        {
          name: 'S',
          rows:
            row(1, fml('A1', 'B1/2+1', 0) + fml('B1', 'A1', 0)) +
            row(2, fml('A2', 'B2+1', 0) + fml('B2', 'A2', 0)) +
            row(3, fml('A3', 'A1*10', 0)),
        },
      ],
    })

  it('without iterative calculation: Excel’s value is kept, marked', () => {
    const calc = createCalc(openWorkbook(book()))
    expect(calc.cell('S', 0, 0)).toMatchObject({
      kept: true,
      reason: expect.stringMatching(/circular/),
    })
    expect(calc.cell('S', 2, 0)).toMatchObject({ kept: true })
  })

  it('with iterative calculation on: iterates until the change is below iterateDelta', () => {
    const calc = createCalc(
      openWorkbook(book('calcId="191029" iterate="1" iterateCount="100" iterateDelta="0.001"')),
    )
    const a1 = calc.cell('S', 0, 0)
    expect(a1.kept).toBe(false)
    expect(a1.value as number).toBeCloseTo(2, 2)
    expect(calc.cell('S', 0, 1).value as number).toBeCloseTo(2, 2)
    expect(calc.cell('S', 2, 0).value as number).toBeCloseTo(20, 1)
  })

  it('a cycle that does not settle within iterateCount steps is kept, never a guess', () => {
    const calc = createCalc(
      openWorkbook(book('calcId="191029" iterate="1" iterateCount="10" iterateDelta="0.001"')),
    )
    expect(calc.cell('S', 1, 0)).toMatchObject({
      kept: true,
      reason: expect.stringMatching(/does not settle/),
    })
    expect(calc.cell('S', 1, 1)).toMatchObject({ kept: true })
  })
})

describe('xlsx calc: volatile functions', () => {
  it('NOW, TODAY and RAND are calculated afresh with every calculation (every change)', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: row(
            1,
            fml('A1', 'RAND()', 0.5) + fml('B1', 'TODAY()', 1) + fml('C1', 'NOW()-TODAY()', 0),
          ),
        },
      ],
    })
    const one = createCalc(openWorkbook(bytes))
    const two = createCalc(openWorkbook(bytes))
    expect(one.cell('S', 0, 0).value).not.toBe(two.cell('S', 0, 0).value)
    // Stable within one calculation.
    expect(one.cell('S', 0, 0).value).toBe(one.cell('S', 0, 0).value)
    expect(one.cell('S', 0, 1).value as number).toBeGreaterThan(45_000)
    const frac = one.cell('S', 0, 2).value as number
    expect(frac >= 0 && frac < 1).toBe(true)
  })
})
