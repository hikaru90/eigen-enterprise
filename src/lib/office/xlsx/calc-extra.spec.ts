import * as F from '@formulajs/formulajs'
import { describe, expect, it } from 'vitest'
import { canEvaluate, createCalc, ENGINE_FUNCTIONS } from './calc'
import { FIN_FUNCTIONS } from './calc-fin'
import { isParamClassified, paramClass } from './calc-params'
import { buildXlsx, cse, num, row, str, txt } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

const e = (code: string) => ({ error: code })

describe('xlsx calc: GROUPBY, PIVOTBY, PERCENTOF', () => {
  const salesBook = () =>
    buildXlsx({
      sheets: [
        {
          name: 'S',
          rows:
            row(1, txt('A1', 'Region') + txt('B1', 'Item') + txt('C1', 'Sales') + txt('D1', 'Units')) +
            row(2, txt('A2', 'East') + txt('B2', 'Apple') + num('C2', 10) + num('D2', 2)) +
            row(3, txt('A3', 'West') + txt('B3', 'Apple') + num('C3', 20) + num('D3', 4)) +
            row(4, txt('A4', 'East') + txt('B4', 'Pear') + num('C4', 30) + num('D4', 6)) +
            row(5, txt('A5', 'West') + txt('B5', 'Pear') + num('C5', 40) + num('D5', 8)),
        },
      ],
    })
  const calc = createCalc(openWorkbook(salesBook()))
  const ev = (formula: string) => {
    const out = calc.evaluate('S', formula, 'F1')
    return out.kept ? { kept: out.reason } : (out.array ?? out.value)
  }

  it('computes GROUPBY with eta-reduced functions, LAMBDA, headers, sorting, filtering and PERCENTOF', () => {
    expect(ev('GROUPBY(A1:A5,C1:C5,SUM)')).toEqual([
      ['East', 40],
      ['West', 60],
      ['Total', 100],
    ])
    expect(ev('GROUPBY(A1:A5,C1:D5,SUM,3,-1,-2)')).toEqual([
      ['Region', 'Sales', 'Units'],
      ['Total', 100, 20],
      ['West', 60, 12],
      ['East', 40, 8],
    ])
    expect(ev('GROUPBY(A2:A5,C2:C5,PERCENTOF,0,0)')).toEqual([
      ['East', 0.4],
      ['West', 0.6],
    ])
    expect(ev('GROUPBY(A1:A5,C1:C5,LAMBDA(x,AVERAGE(x)),1,1,,B1:B5="Apple")')).toEqual([
      ['East', 10],
      ['West', 20],
      ['Total', 15],
    ])
    expect(ev('GROUPBY(A1:B5,C1:C5,SUM,3,1)')).toEqual([
      ['Region', 'Item', 'Sales'],
      ['East', 'Apple', 10],
      ['East', 'Pear', 30],
      ['West', 'Apple', 20],
      ['West', 'Pear', 40],
      ['Total', '', 100],
    ])
    expect(ev('PERCENTOF(C2:C3,C2:C5)')).toBe(0.3)
  })

  it('computes PIVOTBY across row/col groups, totals and relative_to', () => {
    expect(ev('PIVOTBY(A1:A5,B1:B5,C1:C5,SUM)')).toEqual([
      ['', 'Apple', 'Pear', 'Total'],
      ['East', 10, 30, 40],
      ['West', 20, 40, 60],
      ['Total', 30, 70, 100],
    ])
    expect(ev('PIVOTBY(A1:A5,B1:B5,C1:C5,PERCENTOF,1,1,,1,,,-1+3)')).toEqual([
      ['', 'Apple', 'Pear', 'Total'],
      ['East', 0.1, 0.3, 0.4],
      ['West', 0.2, 0.4, 0.6],
      ['Total', 0.3, 0.7, 1],
    ])
    expect(ev('PIVOTBY(A1:A5,B1:B5,C1:C5,SUM,1,0,,0)')).toEqual([
      ['', 'Apple', 'Pear'],
      ['East', 10, 30],
      ['West', 20, 40],
    ])
  })

  it('refuses undocumented GROUPBY/PIVOTBY cases rather than guessing', () => {
    expect(ev('GROUPBY(A1:A5,C1:C5,SUM,2)')).toHaveProperty('kept')
    expect(ev('GROUPBY(A1:B5,C1:C5,SUM,3,2)')).toHaveProperty('kept')
    expect(ev('PIVOTBY(A1:B5,B1:B5,C1:C5,SUM)')).toHaveProperty('kept')
    expect(ev('PIVOTBY(A1:A5,B1:B5,C1:C5,SUM,3)')).toHaveProperty('kept')
    expect(ev('GROUPBY(A1:A5,C1:C5,SUM,1,1,,C1:C5>999)')).toEqual(e('#CALC!'))
  })
})

describe('xlsx calc: SUBTOTAL, AGGREGATE, MDETERM, MINVERSE', () => {
  const aggBook = () =>
    buildXlsx({
      sheets: [
        {
          name: 'A',
          rows:
            row(1, txt('A1', 'Val') + txt('B1', 'Grp')) +
            row(2, num('A2', 10) + txt('B2', 'x')) +
            row(3, num('A3', 20) + txt('B3', 'y'), ' hidden="1"') +
            row(4, num('A4', 30) + txt('B4', 'x')) +
            row(5, num('A5', 40) + txt('B5', 'z'), ' hidden="1"') +
            row(6, '<c r="A6"><f>SUBTOTAL(9,A2:A4)</f><v>40</v></c>') +
            row(7, '<c r="A7" t="e"><v>#DIV/0!</v></c>'),
          after:
            '<autoFilter ref="A1:B4"><filterColumn colId="1"><filters><filter val="x"/></filters></filterColumn></autoFilter>',
        },
      ],
    })
  const calc = createCalc(openWorkbook(aggBook()))
  const ev = (formula: string) => {
    const out = calc.evaluate('A', formula, 'D1')
    return out.kept ? { kept: out.reason } : (out.array ?? out.value)
  }

  it('handles SUBTOTAL (filtered vs all-hidden, nested exclusion, unions)', () => {
    // Row 3 (20) is inside A1:B4 filter -> excluded by both 9 and 109; row 5 (40) is manual hidden -> included in 9, excluded in 109; A6 nested -> excluded!
    expect(ev('SUBTOTAL(9,A2:A6)')).toBe(80)
    expect(ev('SUBTOTAL(109,A2:A6)')).toBe(40)
    expect(ev('SUBTOTAL(1,A2:A4)')).toBe(20)
    expect(ev('SUBTOTAL(2,A2:A5)')).toBe(3)
    expect(ev('SUBTOTAL(9,(A2:A2,A4:A4))')).toBe(40)
    expect(ev('SUBTOTAL(9,{1,2,3})')).toHaveProperty('kept')
  })

  it('handles AGGREGATE options (ignore hidden, ignore errors, ignore nested, array form)', () => {
    expect(ev('AGGREGATE(9,0,A2:A6)')).toBe(80) // ignore nested + filtered
    expect(ev('AGGREGATE(9,4,A2:A6)')).toBe(120) // ignore nothing -> includes nested A6 (40)
    expect(ev('AGGREGATE(9,5,A2:A6)')).toBe(80) // ignore all hidden -> includes nested A6 (40), skips A3 & A5
    expect(ev('AGGREGATE(9,1,A2:A6)')).toBe(40) // ignore nested + all hidden
    expect(ev('AGGREGATE(9,2,A2:A7)')).toBe(80) // ignore errors + nested + filtered
    expect(ev('AGGREGATE(9,3,A2:A7)')).toBe(40) // ignore hidden + errors + nested
    expect(ev('AGGREGATE(14,4,A2:A5,2)')).toBe(30) // LARGE ignoring filtered row 3 -> {10,30,40}[2nd] = 30
    expect(ev('AGGREGATE(16,6,{10,20,30,40},0.25)')).toBe(17.5) // PERCENTILE.INC
  })

  it('computes MDETERM and MINVERSE', () => {
    expect(ev('MDETERM({1,2;3,4})')).toBeCloseTo(-2, 10)
    expect(ev('MINVERSE({4,7;2,6})')).toEqual([
      [expect.closeTo(0.6, 10), expect.closeTo(-0.7, 10)],
      [expect.closeTo(-0.2, 10), expect.closeTo(0.4, 10)],
    ])
    expect(ev('MINVERSE({1,2;2,4})')).toEqual(e('#NUM!'))
  })
})

describe('xlsx calc: CELL, INFO, SHEET, SHEETS, ISFORMULA, FORMULATEXT, TRIMRANGE', () => {
  const infoBook = () =>
    buildXlsx({
      calcPr: 'calcId="191029" calcMode="manual"',
      strings: ['Hello'],
      sheets: [
        {
          name: 'First',
          rows:
            row(1, str('A1', 0, 3) + num('B1', 42, 1) + '<c r="C1"><f>B1*2</f><v>84</v></c>') +
            row(2, cse('A2', 'A2:A3', 'B1', 42) + num('C2', 45000, 4)) +
            row(3, num('A3', 42)) +
            row(4, num('D4', 9)),
        },
        { name: 'Second', state: 'hidden', rows: row(1, num('A1', 1)) },
      ],
    })
  const calc = createCalc(openWorkbook(infoBook()))
  const ev = (formula: string) => {
    const out = calc.evaluate('First', formula, 'E1')
    return out.kept ? { kept: out.reason } : (out.array ?? out.value)
  }

  it('computes deterministic CELL and INFO properties and refuses machine-dependent ones', () => {
    expect(ev('CELL("address",B1)')).toBe('$B$1')
    expect(ev('CELL("col",B1)')).toBe(2)
    expect(ev('CELL("row",D4)')).toBe(4)
    expect(ev('CELL("contents",C1)')).toBe(84)
    expect(ev('CELL("type",A1)')).toBe('l')
    expect(ev('CELL("type",B1)')).toBe('v')
    expect(ev('CELL("type",C1)')).toBe('v')
    expect(ev('CELL("type",Z9)')).toBe('b')
    expect(ev('CELL("format",B1)')).toBe('G')
    expect(ev('CELL("format",C2)')).toBe('D4')
    expect(ev('CELL("format",A1)')).toHaveProperty('kept')
    expect(ev('CELL("protect",B1)')).toBe(1)
    expect(ev('INFO("recalc")')).toBe('Manual')
    expect(ev('CELL("filename",A1)')).toHaveProperty('kept')
    expect(ev('CELL("address",Second!A1)')).toHaveProperty('kept')
    expect(ev('CELL("row")')).toHaveProperty('kept')
    expect(ev('INFO("osversion")')).toHaveProperty('kept')
  })

  it('computes SHEET, SHEETS, ISFORMULA, FORMULATEXT, TRIMRANGE', () => {
    expect(ev('SHEET()')).toBe(1)
    expect(ev('SHEET("Second")')).toBe(2)
    expect(ev('SHEET(Second!A1)')).toBe(2)
    expect(ev('SHEETS()')).toBe(2)
    expect(ev('SHEETS(Second!A1:B2)')).toBe(1)
    expect(ev('ISFORMULA(C1)')).toBe(true)
    expect(ev('ISFORMULA(B1)')).toBe(false)
    expect(ev('ISFORMULA(A3)')).toBe(true)
    expect(ev('ISFORMULA(B1:C1)')).toEqual([[false, true]])
    expect(ev('FORMULATEXT(C1)')).toBe('=B1*2')
    expect(ev('FORMULATEXT(A2)')).toBe('{=B1}')
    expect(ev('FORMULATEXT(B1)')).toEqual(e('#N/A'))
    expect(ev('SUM(TRIMRANGE(A1:E5))')).toBe(42 + 84 + 42 + 45000 + 42 + 9)
  })
})

describe('xlsx calc: deterministic financial functions & statistical fixes', () => {
  const calc = createCalc(openWorkbook(buildXlsx({ sheets: [{ name: 'S', rows: row(1, num('A1', 1)) }] })))
  const ev = (formula: string) => {
    const out = calc.evaluate('S', formula, 'B1')
    return out.kept ? { kept: out.reason } : (out.array ?? out.value)
  }

  it('computes bond, coupon, depreciation and statistical functions', () => {
    expect(ev('ACCRINTM(DATE(2024,1,1),DATE(2024,7,1),0.05,1000,0)')).toBeCloseTo(25, 6)
    expect(ev('COUPNUM(DATE(2024,1,25),DATE(2025,11,15),2,1)')).toBe(4)
    expect(ev('COUPDAYBS(DATE(2007,1,25),DATE(2008,11,15),2,1)')).toBe(71)
    expect(ev('COUPDAYSNC(DATE(2007,1,25),DATE(2008,11,15),2,1)')).toBe(110)
    expect(ev('INTRATE(DATE(2024,1,1),DATE(2024,7,1),1000,1025,0)')).toBeCloseTo(0.05, 6)
    expect(ev('RECEIVED(DATE(2024,1,1),DATE(2024,7,1),1000,0.05,0)')).toBeCloseTo(1000 / 0.975, 6)
    expect(ev('YIELDDISC(DATE(2024,1,1),DATE(2024,7,1),97.5,100,0)')).toBeCloseTo(
      ((100 - 97.5) / 97.5) * 2,
      6,
    )
    const p = ev('PRICE(DATE(2024,2,15),DATE(2030,11,15),0.0575,0.065,100,2,0)') as number
    expect(p).toBeGreaterThan(90)
    expect(ev(`YIELD(DATE(2024,2,15),DATE(2030,11,15),0.0575,${p},100,2,0)`)).toBeCloseTo(
      0.065,
      5,
    )
    expect(ev('DURATION(DATE(2024,1,1),DATE(2026,1,1),0.08,0.08,2,0)')).toBeGreaterThan(1.5)
    expect(ev('MDURATION(DATE(2024,1,1),DATE(2026,1,1),0.08,0.08,2,0)')).toBeLessThan(
      ev('DURATION(DATE(2024,1,1),DATE(2026,1,1),0.08,0.08,2,0)') as number,
    )
    expect(ev('VDB(2400,300,10,0,1)')).toBeCloseTo(480, 6)
    expect(ev('AMORLINC(2400,DATE(2008,8,19),DATE(2008,12,31),300,1,0.15,1)')).toBeCloseTo(360, 6)
    expect(ev('T.DIST(1,1,TRUE)')).toBeCloseTo(0.75, 6)
    expect(ev('CHIDIST(1,1)')).toBeCloseTo(0.3173105, 5)
    expect(ev('CHIINV(0.05,1)')).toBeCloseTo(3.8414588, 4)
    expect(ev('FDIST(15.20686486,6,4)')).toBeCloseTo(0.01, 5)
    expect(ev('FINV(0.01,6,4)')).toBeCloseTo(15.20686486, 4)
    expect(ev('ECMA.CEILING(-4.1,2)')).toBe(-4)
    expect(ev('TYPE(C99)')).toBe(1)
    expect(ev('TYPE({1,2})')).toBe(64)
    expect(ev('FREQUENCY({79;85;78;85;50;81;95;88;97},{70;79;89})')).toEqual([[1], [2], [4], [2]])
    expect(ev('MODE.MULT({1;2;2;3;3;4})')).toEqual([[2], [3]])
  })
})

describe('calc-params.ts audit: every implemented function is explicitly classified', () => {
  it('classifies every function in ENGINE_FUNCTIONS, FIN_FUNCTIONS, and @formulajs/formulajs', () => {
    const names = new Set<string>([
      ...ENGINE_FUNCTIONS,
      ...Object.keys(FIN_FUNCTIONS),
      'ISBLANK',
      'TEXT',
      'HYPERLINK',
      'TYPE',
      'T.DIST',
      'STDEV',
      'STDEVP',
      'VAR',
      'VARP',
      'MODE',
      'PERCENTILE',
      'QUARTILE',
      'RANK',
      'PERCENTRANK',
      'POISSON',
      'WEIBULL',
      'CONFIDENCE',
      'CHIDIST',
      'CHIINV',
      'FDIST',
      'FINV',
      'ECMA.CEILING',
      'FORECAST.LINEAR',
      'ERF.PRECISE',
      'ERFC.PRECISE',
    ])
    function walk(o: unknown, prefix: string) {
      if (!o || (typeof o !== 'object' && typeof o !== 'function')) return
      for (const [k, v] of Object.entries(o)) {
        if (k === 'default' || k === 'utils') continue
        const full = prefix ? `${prefix}.${k}` : k
        if (typeof v === 'function') names.add(full.toUpperCase())
        walk(v, full)
      }
    }
    walk(F, '')
    for (const n of names) {
      expect(canEvaluate(n), `canEvaluate(${n})`).toBe(true)
      expect(isParamClassified(n), `isParamClassified(${n})`).toBe(true)
    }
    // Spot-check critical range classifications that caused lifting bugs before the audit.
    expect(paramClass('TEXTBEFORE', 1)).toBe('range')
    expect(paramClass('TEXTAFTER', 1)).toBe('range')
    expect(paramClass('ARRAYTOTEXT', 0)).toBe('range')
    expect(paramClass('PERCENTOF', 0)).toBe('range')
    expect(paramClass('PERCENTOF', 1)).toBe('range')
    expect(paramClass('CELL', 1)).toBe('range')
    expect(paramClass('SHEET', 0)).toBe('range')
    expect(paramClass('SHEETS', 0)).toBe('range')
    expect(paramClass('ISREF', 0)).toBe('range')
    expect(paramClass('OFFSET', 0)).toBe('range')
    expect(paramClass('GETPIVOTDATA', 1)).toBe('range')
    expect(paramClass('ROW', 0)).toBe('value')
  })
})
