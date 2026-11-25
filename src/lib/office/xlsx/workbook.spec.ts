import { describe, expect, it } from 'vitest'
import { createCalc } from './calc'
import { displayValue, editText, formatCode, parseInput } from './format'
import { cellKey } from './ref'
import { budgetBook, buildXlsx, fml, num, row, str } from './test-utils/build-xlsx'
import { openWorkbook, XlsxError } from './workbook'

const cellOf = (bytes: Uint8Array, sheet: string, ref: [number, number]) =>
  openWorkbook(bytes)
    .sheet(sheet)
    .cells.get(cellKey(...ref))

describe('xlsx workbook: reading', () => {
  it('lists the sheets in tab order with their kind and visibility', () => {
    const wb = openWorkbook(
      buildXlsx({ sheets: [{ name: 'One' }, { name: 'Secret', state: 'hidden' }] }),
    )
    expect(wb.sheets().map((s) => [s.name, s.kind, s.state, s.index])).toEqual([
      ['One', 'worksheet', 'visible', 0],
      ['Secret', 'worksheet', 'hidden', 1],
    ])
    expect(wb.findSheet('secret')?.name).toBe('Secret')
    expect(() => wb.requireSheet('Nope')).toThrow(/no sheet called “Nope”/)
  })

  it('reads values, shared strings, formulas with their cached results, styles, columns and merges', () => {
    const wb = openWorkbook(budgetBook())
    const s = wb.sheet('Budget')
    expect(s.cells.get(cellKey(0, 0))).toMatchObject({ value: 'Item', style: 1, formula: null })
    expect(s.cells.get(cellKey(1, 1))).toMatchObject({ value: 1200, style: 2 })
    expect(s.cells.get(cellKey(3, 1))).toMatchObject({
      value: 1500,
      formula: 'SUM(B2:B3)',
      formulaType: 'normal',
    })
    expect([s.maxRow, s.maxCol]).toEqual([3, 3])
    expect(s.cols[0]).toMatchObject({ min: 0, max: 0, widthPx: 145 })
    expect(s.merges).toEqual([{ top: 0, left: 4, bottom: 0, right: 5 }])
    expect(wb.styles().xf(1).font).toMatchObject({ bold: true, color: '#C00000' })
    expect(wb.styles().xf(2).fill).toBe('#FFFF00')
    expect(wb.styles().xf(3).numFmt).toBe('0.0%')
    expect(wb.styles().xf(0).font.color).toBe('#000000')
    expect(wb.definedNames()).toEqual([
      { name: 'Costs', localSheet: null, formula: 'Budget!$B$2:$B$3', hidden: false },
    ])
  })

  it('writes a shared formula out for every cell it covers', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows:
            row(
              1,
              num('A1', 1) + '<c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c>',
            ) +
            row(2, num('A2', 2) + '<c r="B2"><f t="shared" si="0"/><v>4</v></c>') +
            row(3, num('A3', 3) + '<c r="B3"><f t="shared" si="0"/><v>6</v></c>'),
        },
      ],
    })
    expect(cellOf(bytes, 'S', [2, 1])).toMatchObject({
      formula: 'A3*2',
      formulaType: 'shared',
      value: 6,
    })
  })

  it('refuses what is not a workbook, loudly', () => {
    expect(() => openWorkbook(new Uint8Array([1, 2, 3]))).toThrow(/Not a ZIP/)
  })

  it('refuses a cell that points at a shared string the workbook does not have', () => {
    const bytes = buildXlsx({ strings: ['a'], sheets: [{ name: 'S', rows: row(1, str('A1', 7)) }] })
    expect(() => openWorkbook(bytes).sheet('S')).toThrow(XlsxError)
  })
})

describe('xlsx calc: formulas evaluated', () => {
  it('calculates references, ranges, names, other sheets and functions', () => {
    const wb = openWorkbook(budgetBook())
    const calc = createCalc(wb)
    expect(calc.cell('Budget', 3, 1)).toEqual({ value: 1500, kept: false })
    expect(calc.cell('Budget', 3, 2)).toEqual({ value: 125, kept: false })
    expect(calc.cell('Budget', 3, 3)).toEqual({ value: 1500, kept: false })
    expect(calc.cell('Summary', 0, 0)).toEqual({ value: 3000, kept: false })
    expect(calc.cell('Summary', 0, 1)).toEqual({ value: 125, kept: false })
  })

  it.each([
    ['1+2*3', 7],
    ['(1+2)*3', 9],
    ['2^3', 8],
    ['-2^2', 4],
    ['50%', 0.5],
    ['"a"&1&TRUE', 'a1TRUE'],
    ['1/0', { error: '#DIV/0!' }],
    ['"x"+1', { error: '#VALUE!' }],
    ['"2"+1', 3],
    ['1=1', true],
    ['"abc"="ABC"', true],
    ['"a"<1', false],
    ['IF(1>2,"yes","no")', 'no'],
    ['IFERROR(1/0,"none")', 'none'],
    ['ROUND(2.345,2)', 2.35],
    ['SUM(1,2,3)', 6],
    ['AVERAGE(2,4)', 3],
    ['MAX(1,5,3)', 5],
    ['CONCATENATE("a","b")', 'ab'],
    ['_xlfn.CONCAT("a","b")', 'ab'],
    ['LEN("hello")', 5],
    ['UPPER("x")', 'X'],
    ['DATE(2024,1,1)', 45292],
    ['YEAR(45292)', 2024],
    ['TEXT(0.25,"0%")', '25%'],
    ['NA()', { error: '#N/A' }],
    ['SUM({1,2;3,4})', 10],
    ['ROW(B7)', 7],
    ['COLUMNS(A1:D2)', 4],
  ])('=%s → %j', (formula, value) => {
    const calc = createCalc(openWorkbook(budgetBook()))
    expect(calc.evaluate('Budget', formula)).toEqual({ value, kept: false })
  })

  it('looks things up in ranges', () => {
    const calc = createCalc(openWorkbook(budgetBook()))
    expect(calc.evaluate('Budget', 'VLOOKUP("Food",A2:B3,2,FALSE)').value).toBe(300)
    expect(calc.evaluate('Budget', 'MATCH("Food",A1:A4,0)').value).toBe(3)
    expect(calc.evaluate('Budget', 'SUMIF(B2:B3,">500")').value).toBe(1200)
    expect(calc.evaluate('Budget', 'COUNTA(A1:A4)').value).toBe(4)
  })

  it('keeps Excel’s value (and says why) for what it can’t calculate, never a guess', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows:
            row(
              1,
              num('A1', 5) +
                fml('B1', 'OFFSET(A1,0,0)', 5) +
                fml('C1', 'B1*2', 10) +
                fml('D1', 'NOSUCHFN(1)', 9),
            ) + row(2, fml('A2', 'B2', 0) + fml('B2', 'A2', 0)),
        },
      ],
    })
    const calc = createCalc(openWorkbook(bytes))
    expect(calc.cell('S', 0, 1)).toEqual({ value: 5, kept: true, reason: 'OFFSET' })
    expect(calc.cell('S', 0, 2)).toEqual({ value: 10, kept: true, reason: 'OFFSET' })
    expect(calc.cell('S', 0, 3)).toEqual({ value: 9, kept: true, reason: 'NOSUCHFN' })
    expect(calc.cell('S', 1, 0)).toMatchObject({
      kept: true,
      reason: expect.stringMatching(/circular/),
    })
  })

  it('an empty referenced cell counts as 0; a reference to a missing sheet is #REF!', () => {
    const calc = createCalc(openWorkbook(budgetBook()))
    expect(calc.evaluate('Budget', 'Z99')).toEqual({ value: 0, kept: false })
    expect(calc.evaluate('Budget', 'Z99&"x"')).toEqual({ value: 'x', kept: false })
    expect(calc.evaluate('Budget', 'Nowhere!A1')).toEqual({
      value: { error: '#REF!' },
      kept: false,
    })
  })
})

describe('xlsx format: shown and typed values', () => {
  it('shows values through their number format, in the person’s locale', () => {
    expect(displayValue(1234.5, '#,##0.00', 'en').text).toBe('1,234.50')
    expect(displayValue(1234.5, '#,##0.00', 'de').text).toBe('1.234,50')
    expect(displayValue(0.256, '0.0%', 'en').text).toBe('25.6%')
    expect(displayValue(45292, formatCode(14, 'mm-dd-yy', 'en'), 'en').text).toBe('1/1/2024')
    expect(displayValue(45292, formatCode(14, 'mm-dd-yy', 'de'), 'de').text).toBe('01.01.2024')
    expect(displayValue(true, 'General', 'de').text).toBe('WAHR')
    expect(displayValue({ error: '#N/A' }, 'General', 'en').text).toBe('#N/A')
    expect(displayValue(-3, '0;[Red]-0', 'en')).toMatchObject({ text: '-3', color: 'red' })
  })

  it('reads typed input the way Excel does', () => {
    expect(parseInput('=SUM(A1:A3)', 'en')).toEqual({ kind: 'formula', formula: 'SUM(A1:A3)' })
    expect(parseInput('12.5', 'en')).toEqual({ kind: 'value', value: 12.5 })
    expect(parseInput('12,5', 'de')).toEqual({ kind: 'value', value: 12.5 })
    expect(parseInput('50%', 'en')).toEqual({ kind: 'value', value: 0.5, format: '0%' })
    expect(parseInput('2024-01-01', 'en')).toEqual({
      kind: 'value',
      value: 45292,
      format: 'mm-dd-yy',
    })
    expect(parseInput('wahr', 'de')).toEqual({ kind: 'value', value: true })
    expect(parseInput("'007", 'en')).toEqual({ kind: 'value', value: '007' })
    expect(parseInput('hello', 'en')).toEqual({ kind: 'value', value: 'hello' })
    expect(parseInput('', 'en')).toEqual({ kind: 'value', value: null })
  })

  it('gives the text to edit back in a form that reads the same', () => {
    expect(editText(5, 'A1*2', 'General', 'en')).toBe('=A1*2')
    expect(editText('007', null, 'General', 'en')).toBe("'007")
    expect(editText('plain', null, 'General', 'en')).toBe('plain')
    expect(editText(12.5, null, 'General', 'de')).toBe('12,5')
    expect(editText(45292, null, 'yyyy-mm-dd', 'en')).toBe('2024-01-01')
  })
})
