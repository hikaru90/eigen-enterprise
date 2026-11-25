import { describe, expect, it } from 'vitest'
import { createCalc } from './calc'
import { buildXlsx, fml, num, row, txt } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

/**
 * Functions that return references (OFFSET, INDIRECT, INDEX, the range
 * operators) and structured table references, against Excel's documented
 * results.
 */
const TABLE_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml'
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

const book = () =>
  buildXlsx({
    definedNames: '<definedName name="Qty">D!$B$1:$B$5</definedName>',
    sheets: [
      {
        name: 'D',
        rows:
          row(1, txt('A1', 'Apple') + num('B1', 5) + num('C1', 1.2)) +
          row(2, txt('A2', 'banana') + num('B2', 3) + num('C2', 0.5)) +
          row(3, txt('A3', 'Cherry') + num('B3', 8) + num('C3', 3)) +
          row(4, txt('A4', 'Date') + num('B4', 3) + num('C4', 2.5)) +
          row(5, txt('A5', 'Elder') + num('B5', 1) + num('C5', 4)),
      },
      { name: 'Other Sheet', rows: row(1, num('A1', 42)) },
      {
        name: 'T',
        rels: [
          { id: 'rId1', type: 'table', target: '../tables/table1.xml' },
          { id: 'rId2', type: 'table', target: '../tables/table2.xml' },
        ],
        after:
          '<tableParts count="2"><tablePart r:id="rId1"/><tablePart r:id="rId2"/></tableParts>',
        rows:
          row(
            1,
            txt('A1', 'Item') +
              txt('B1', 'Qty') +
              txt('C1', 'Price') +
              txt('D1', 'Total') +
              txt('F1', 'Name') +
              txt('G1', 'Amount'),
          ) +
          row(
            2,
            txt('A2', 'Apple') +
              num('B2', 5) +
              num('C2', 1.2) +
              fml('D2', 'Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]', 0) +
              txt('F2', 'Rent') +
              num('G2', 100),
          ) +
          row(
            3,
            txt('A3', 'Pear') +
              num('B3', 3) +
              num('C3', 0.5) +
              fml('D3', '[@Qty]*[@Price]', 0) +
              txt('F3', 'Food') +
              num('G3', 50),
          ) +
          row(
            4,
            txt('A4', 'Fig') +
              num('B4', 8) +
              num('C4', 3) +
              fml('D4', 'Sales[@Qty]*2', 0) +
              txt('F4', 'Total') +
              fml('G4', 'SUBTOTAL(109,Costs[Amount])', 0),
          ) +
          row(6, fml('A6', 'Sales[@Qty]', 0)),
      },
    ],
    parts: {
      '/xl/tables/table1.xml': {
        type: TABLE_CT,
        xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="${NS}" id="1" name="Sales" displayName="Sales" ref="A1:D4" totalsRowShown="0"><autoFilter ref="A1:D4"/><tableColumns count="4"><tableColumn id="1" name="Item"/><tableColumn id="2" name="Qty"/><tableColumn id="3" name="Price"/><tableColumn id="4" name="Total"/></tableColumns></table>`,
      },
      '/xl/tables/table2.xml': {
        type: TABLE_CT,
        xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="${NS}" id="2" name="Costs" displayName="Costs" ref="F1:G4" totalsRowCount="1"><tableColumns count="2"><tableColumn id="1" name="Name"/><tableColumn id="2" name="Amount"/></tableColumns></table>`,
      },
    },
  })

const calc = createCalc(openWorkbook(book()))
const ev = (formula: string, at?: string, sheet = 'D') => {
  const out = calc.evaluate(sheet, formula, at)
  if (out.kept) return { kept: out.reason }
  return out.array ?? out.value
}
const e = (code: string) => ({ error: code })

describe('xlsx calc: references from functions', () => {
  it.each([
    ['OFFSET(B1,2,0)', 8],
    ['SUM(OFFSET(B1,1,0,3,1))', 14],
    ['ROWS(OFFSET(A1,0,0,3,2))', 3],
    ['COLUMNS(OFFSET(A1,0,0,3,2))', 2],
    ['OFFSET(A1,-1,0)', e('#REF!')],
    ['OFFSET(B1,0,0,0,1)', e('#REF!')],
    // B1:C2 one down and one right is C2:D3 (D is empty: a spilled blank shows 0).
    [
      'OFFSET(B1:C2,1,1)',
      [
        [0.5, 0],
        [3, 0],
      ],
    ],
  ])('=%s → %j', (formula, value) => {
    expect(ev(formula)).toEqual(value)
  })

  it.each([
    ['INDIRECT("B3")', 8],
    ['SUM(INDIRECT("B1:B5"))', 20],
    ['INDIRECT("\'Other Sheet\'!A1")', 42],
    ['INDIRECT("D!B2")', 3],
    ['INDIRECT("R3C2",FALSE)', 8],
    ['SUM(INDIRECT("R1C2:R5C2",FALSE))', 20],
    ['INDIRECT("\'Other Sheet\'!R1C1",FALSE)', 42],
    ['SUM(INDIRECT("Qty"))', 20],
    ['INDIRECT("Nope!A1")', e('#REF!')],
    ['INDIRECT("not a ref")', e('#REF!')],
    ['INDIRECT("B"&(1+2))', 8],
  ])('=%s → %j', (formula, value) => {
    expect(ev(formula)).toEqual(value)
  })

  it('INDIRECT with relative R1C1 counts from the formula’s cell', () => {
    expect(ev('INDIRECT("R[1]C",FALSE)', 'B2')).toBe(8)
    expect(ev('INDIRECT("RC[-1]",FALSE)', 'C3')).toBe(8)
  })

  it.each([
    ['INDEX(A1:C5,3,2)', 8],
    ['SUM(INDEX(A1:C5,0,2))', 20],
    ['SUM(INDEX(B1:C5,2,0))', 3.5],
    ['SUM(B1:INDEX(B1:B5,3))', 16],
    ['INDEX(B1:B5,3)', 8],
    ['INDEX(A1:C1,2)', 5],
    ['INDEX(B1:B5,9)', e('#REF!')],
    ['INDEX({1,2;3,4},2,2)', 4],
    ['INDEX({1,2,3},2)', 2],
    ['ROW(INDEX(A1:C5,4,1))', 4],
    ['SUM(B1:B2 B2:C3)', 3],
    ['B1:B2 C4:C5', e('#NULL!')],
    ['SUM(B1:C1:B3)', 5 + 1.2 + 3 + 0.5 + 8 + 3],
  ])('=%s → %j', (formula, value) => {
    expect(ev(formula)).toEqual(value)
  })

  it('ROW() and COLUMN() without a reference are the formula’s own cell', () => {
    expect(ev('ROW()', 'C7')).toBe(7)
    expect(ev('COLUMN()', 'C7')).toBe(3)
    expect(ev('ROW()')).toEqual({ kept: expect.stringMatching(/cell/) })
  })

  it('range unions work in multi-range aggregates and multi-area INDEX; unsupported uses stay uncalculated', () => {
    expect(ev('SUM((B1,B3))')).toBe(13)
    expect(ev('SUM((B1:B2,B4:B5))')).toBe(12)
    expect(ev('AVERAGE((B1:B2,B5))')).toBe(3)
    expect(ev('COUNT((B1,B3:B5))')).toBe(4)
    expect(ev('MAX((B1,B4:B5))')).toBe(5)
    expect(ev('MIN((B1,B4:B5))')).toBe(1)
    expect(ev('CONCAT((A1,A3))')).toBe('AppleCherry')
    expect(ev('TEXTJOIN(",",TRUE,(A1,A4:A5))')).toBe('Apple,Date,Elder')
    expect(ev('AREAS((A1:B2,C3:C5,B1))')).toBe(3)
    expect(ev('ISREF((B1,B3))')).toBe(true)
    expect(ev('ROWS((B1,B3))')).toEqual(e('#REF!'))
    expect(ev('INDEX((A1:B2,B4:C5),2,1,2)')).toBe(1)
    expect(ev('INDEX((A1:B2,B4:C5),1,2,2)')).toBe(2.5)
    expect(ev('SUM(INDEX((A1:B2,B4:C5),0,1,2))')).toBe(4)
    expect(ev('INDEX((A1:B2,B4:C5),1,1,3)')).toEqual(e('#REF!'))
    expect(ev('INDEX((A1:B2,B4:C5),1,1,0)')).toEqual(e('#VALUE!'))
    expect(ev('(B1,B3)+1')).toEqual({ kept: expect.stringMatching(/union/) })
    expect(ev('VLOOKUP("Apple",(A1:B2,A4:B5),2,FALSE)')).toEqual({
      kept: expect.stringMatching(/union/),
    })
  })
})

describe('xlsx calc: structured (table) references', () => {
  it.each([
    ['SUM(Sales[Qty])', 16],
    ['Sales[[#Headers],[Price]]', 'Price'],
    ['ROWS(Sales[#All])', 4],
    ['ROWS(Sales)', 3],
    ['ROWS(Sales[#Data])', 3],
    ['COLUMNS(Sales[[Item]:[Qty]])', 2],
    ['COLUMNS(Sales[#Headers])', 4],
    ['SUM(sales[qty])', 16],
    ['Costs[[#Totals],[Amount]]', 150],
    ['SUM(Costs[Amount])', 150],
    ['ROWS(Costs[[#Data],[#Totals]])', 3],
    ['Sales[#Totals]', e('#REF!')],
    ['Sales[Nope]', e('#REF!')],
    ['SUM(Nope[Qty])', e('#REF!')],
  ])('=%s → %j', (formula, value) => {
    expect(ev(formula, undefined, 'T')).toEqual(value)
  })

  it('this-row references read the formula’s own row of the table', () => {
    const c = createCalc(openWorkbook(book()))
    expect(c.cell('T', 1, 3)).toEqual({ value: 6, kept: false })
    expect(c.cell('T', 2, 3)).toEqual({ value: 1.5, kept: false })
    expect(c.cell('T', 3, 3)).toEqual({ value: 16, kept: false })
    // Outside the table's rows there is no "this row".
    expect(c.cell('T', 5, 0)).toEqual({ value: { error: '#VALUE!' }, kept: false })
  })

  it('INDIRECT reads table references too', () => {
    expect(ev('SUM(INDIRECT("Sales[Qty]"))', undefined, 'T')).toBe(16)
  })
})
