import { describe, expect, it } from 'vitest'
import { createCalc } from './calc'
import { buildXlsx, num, row, txt } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

/**
 * Dynamic-array, lookup and LAMBDA functions against the results Microsoft's
 * function reference documents. Sheet D: A1:A5 names, B1:B5 quantities,
 * C1:C5 prices, E1:E5 a sorted column, F1:F3 with a blank in F2.
 */
const book = () =>
  buildXlsx({
    definedNames: '<definedName name="Double">_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2)</definedName>',
    sheets: [
      {
        name: 'D',
        rows:
          row(
            1,
            txt('A1', 'Apple') + num('B1', 5) + num('C1', 1.2) + num('E1', 10) + num('F1', 1),
          ) +
          row(2, txt('A2', 'banana') + num('B2', 3) + num('C2', 0.5) + num('E2', 20)) +
          row(3, txt('A3', 'Cherry') + num('B3', 8) + num('C3', 3) + num('E3', 30) + num('F3', 3)) +
          row(4, txt('A4', 'Date') + num('B4', 3) + num('C4', 2.5) + num('E4', 40)) +
          row(5, txt('A5', 'Elder') + num('B5', 1) + num('C5', 4) + num('E5', 50)),
      },
    ],
  })

const calc = createCalc(openWorkbook(book()))
const ev = (formula: string, at?: string) => {
  const out = calc.evaluate('D', formula, at)
  if (out.kept) return { kept: out.reason }
  return out.array ?? out.value
}
const e = (code: string) => ({ error: code })
const NA = e('#N/A')

describe('xlsx calc: XLOOKUP and XMATCH', () => {
  it.each([
    ['XLOOKUP("Cherry",A1:A5,B1:B5)', 8],
    ['XLOOKUP("cherry",A1:A5,B1:B5)', 8],
    ['XLOOKUP("Fig",A1:A5,B1:B5)', NA],
    ['XLOOKUP("Fig",A1:A5,B1:B5,"none")', 'none'],
    ['XLOOKUP(3,B1:B5,A1:A5)', 'banana'],
    ['XLOOKUP(3,B1:B5,A1:A5,,0,-1)', 'Date'],
    ['XLOOKUP(4,B1:B5,A1:A5,,-1)', 'banana'],
    ['XLOOKUP(4,B1:B5,A1:A5,,1)', 'Apple'],
    ['XLOOKUP(9,B1:B5,A1:A5,,1)', NA],
    ['XLOOKUP("b*",A1:A5,B1:B5,,2)', 3],
    ['XLOOKUP("?herry",A1:A5,B1:B5,,2)', 8],
    ['XLOOKUP("Date",A1:A5,B1:C5)', [[3, 2.5]]],
    ['XLOOKUP(2,{1,2,3},{"a","b","c"})', 'b'],
    ['XLOOKUP("Apple",A1:A5,B1:B4)', e('#VALUE!')],
    ['XLOOKUP(30,E1:E5,E1:E5,,0,2)', 30],
    ['XLOOKUP(35,E1:E5,E1:E5,,-1,2)', 30],
    ['XLOOKUP(35,E1:E5,E1:E5,,1,2)', 40],
    ['XLOOKUP(35,E1:E5,E1:E5,,0,2)', NA],
    ['XLOOKUP(20,{50,40,30,20,10},{1,2,3,4,5},,0,-2)', 4],
    // XLOOKUP returns a reference, so two of them make a range.
    ['SUM(XLOOKUP("banana",A1:A5,B1:B5):XLOOKUP("Date",A1:A5,B1:B5))', 14],
  ])('=%s → %j', (formula, value) => {
    expect(ev(formula)).toEqual(value)
  })

  it('a binary search over unsorted values is not guessed', () => {
    expect(ev('XLOOKUP(3,B1:B5,A1:A5,,0,2)')).toEqual({ kept: expect.stringMatching(/sorted/) })
  })

  it.each([
    ['XMATCH(4,{5,4,3,2,1})', 2],
    ['XMATCH(4.5,{5,4,3,2,1},1)', 1],
    ['XMATCH(4.5,{5,4,3,2,1},-1)', 2],
    ['XMATCH("c*",{"apple","cherry","citrus"},2)', 2],
    ['XMATCH(3,{1,3,3,5},0,-1)', 3],
    ['XMATCH(9,{1,2})', NA],
    ['XMATCH("Elder",A1:A5)', 5],
    ['XMATCH({3,8},B1:B5)', [[2, 3]]],
  ])('=%s → %j', (formula, value) => {
    expect(ev(formula)).toEqual(value)
  })
})

describe('xlsx calc: dynamic-array functions', () => {
  it.each([
    ['FILTER(A1:A5,B1:B5>3)', [['Apple'], ['Cherry']]],
    [
      'FILTER(A1:C5,B1:B5=3)',
      [
        ['banana', 3, 0.5],
        ['Date', 3, 2.5],
      ],
    ],
    ['FILTER(A1:A5,(B1:B5>2)*(C1:C5<3))', [['Apple'], ['banana'], ['Date']]],
    ['FILTER(A1:A5,B1:B5>100)', e('#CALC!')],
    ['FILTER(A1:A5,B1:B5>100,"none")', 'none'],
    ['FILTER(A1:A5,{1;0})', e('#VALUE!')],
    ['FILTER({1,2,3},{TRUE,FALSE,TRUE})', [[1, 3]]],
    ['SORT({3;1;2})', [[1], [2], [3]]],
    ['SORT({3;1;2},1,-1)', [[3], [2], [1]]],
    [
      'SORT(A1:B5,2,-1)',
      [
        ['Cherry', 8],
        ['Apple', 5],
        ['banana', 3],
        ['Date', 3],
        ['Elder', 1],
      ],
    ],
    [
      'SORT(A1:B5,{2,1},{1,-1})',
      [
        ['Elder', 1],
        ['Date', 3],
        ['banana', 3],
        ['Apple', 5],
        ['Cherry', 8],
      ],
    ],
    ['SORT({"b","a","C"},1,1,TRUE)', [['a', 'b', 'C']]],
    ['SORT({2;"a";TRUE;1})', [[1], [2], ['a'], [true]]],
    ['SORT({"co-op";"coop";"cob"})', [['cob'], ['coop'], ['co-op']]],
    ['SORT({1;2},3)', e('#VALUE!')],
    ['SORTBY(A1:A5,B1:B5)', [['Elder'], ['banana'], ['Date'], ['Apple'], ['Cherry']]],
    ['SORTBY(A1:A5,B1:B5,-1,C1:C5,1)', [['Cherry'], ['Apple'], ['banana'], ['Date'], ['Elder']]],
    ['SORTBY(A1:A5,B1:B4)', e('#VALUE!')],
    ['UNIQUE({1;2;2;3;1})', [[1], [2], [3]]],
    ['UNIQUE({1;2;2;3;1},FALSE,TRUE)', 3],
    ['UNIQUE({"a";"A";"b"})', [['a'], ['b']]],
    ['UNIQUE(B1:B5)', [[5], [3], [8], [1]]],
    ['UNIQUE({1,1,2},TRUE)', [[1, 2]]],
    ['UNIQUE({1;1},FALSE,TRUE)', e('#CALC!')],
    [
      'SEQUENCE(2,3)',
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
    ],
    ['SEQUENCE(3,1,10,-2)', [[10], [8], [6]]],
    ['SEQUENCE(0)', e('#CALC!')],
    [
      'TAKE({1,2,3;4,5,6;7,8,9},2)',
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
    ],
    [
      'TAKE({1,2,3;4,5,6;7,8,9},,2)',
      [
        [1, 2],
        [4, 5],
        [7, 8],
      ],
    ],
    [
      'TAKE({1,2,3;4,5,6;7,8,9},-2)',
      [
        [4, 5, 6],
        [7, 8, 9],
      ],
    ],
    ['TAKE({1,2,3;4,5,6;7,8,9},2,-1)', [[3], [6]]],
    ['TAKE({1,2,3},0)', e('#CALC!')],
    ['DROP({1,2,3;4,5,6;7,8,9},2)', [[7, 8, 9]]],
    ['DROP({1,2,3;4,5,6;7,8,9},,-2)', [[1], [4], [7]]],
    ['DROP({1,2,3;4,5,6;7,8,9},3)', e('#CALC!')],
    [
      'VSTACK({1,2},{3,4;5,6})',
      [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    ],
    [
      'VSTACK({1,2},3)',
      [
        [1, 2],
        [3, NA],
      ],
    ],
    [
      'HSTACK({1;2},{3;4})',
      [
        [1, 3],
        [2, 4],
      ],
    ],
    [
      'HSTACK(1,{2;3})',
      [
        [1, 2],
        [NA, 3],
      ],
    ],
    ['TOCOL({1,2;3,4})', [[1], [2], [3], [4]]],
    ['TOCOL({1,2;3,4},0,TRUE)', [[1], [3], [2], [4]]],
    ['TOROW({1,2;3,4})', [[1, 2, 3, 4]]],
    ['TOCOL(F1:F3)', [[1], [0], [3]]],
    ['TOCOL(F1:F3,1)', [[1], [3]]],
    ['TOCOL({1,#N/A;3,4},2)', [[1], [3], [4]]],
    [
      'CHOOSECOLS({1,2,3;4,5,6},1,3)',
      [
        [1, 3],
        [4, 6],
      ],
    ],
    ['CHOOSECOLS({1,2,3;4,5,6},-1)', [[3], [6]]],
    ['CHOOSECOLS({1,2,3;4,5,6},4)', e('#VALUE!')],
    [
      'CHOOSEROWS({1,2;3,4;5,6},3,1)',
      [
        [5, 6],
        [1, 2],
      ],
    ],
    ['TEXTSPLIT("Dakota Lennox Patrick"," ")', [['Dakota', 'Lennox', 'Patrick']]],
    [
      'TEXTSPLIT("1,2,3;4,5,6",",",";")',
      [
        ['1', '2', '3'],
        ['4', '5', '6'],
      ],
    ],
    ['TEXTSPLIT("a,,b",",")', [['a', '', 'b']]],
    ['TEXTSPLIT("a,,b",",",,TRUE)', [['a', 'b']]],
    ['TEXTSPLIT("a-b_c",{"-","_"})', [['a', 'b', 'c']]],
    [
      'TEXTSPLIT("1,2;3",",",";")',
      [
        ['1', '2'],
        ['3', NA],
      ],
    ],
    [
      'TEXTSPLIT("1,2;3",",",";",FALSE,0,"-")',
      [
        ['1', '2'],
        ['3', '-'],
      ],
    ],
    ['TEXTSPLIT("aXbxc","x",,,1)', [['a', 'b', 'c']]],
    ['TEXTSPLIT("aXbxc","x")', [['aXb', 'c']]],
    [
      'WRAPROWS({1,2,3,4,5},2)',
      [
        [1, 2],
        [3, 4],
        [5, NA],
      ],
    ],
    [
      'WRAPCOLS({1,2,3,4,5},2)',
      [
        [1, 3, 5],
        [2, 4, NA],
      ],
    ],
    [
      'EXPAND({1,2;3,4},3,3,0)',
      [
        [1, 2, 0],
        [3, 4, 0],
        [0, 0, 0],
      ],
    ],
    ['EXPAND({1},1,2)', [[1, NA]]],
    ['EXPAND({1,2},1,1)', e('#VALUE!')],
    [
      'TRANSPOSE({1,2;3,4})',
      [
        [1, 3],
        [2, 4],
      ],
    ],
  ])('=%s → %j', (formula, value) => {
    expect(ev(formula)).toEqual(value)
  })

  it('sorting blanks is not guessed (Excel does not document their order)', () => {
    expect(ev('SORT(F1:F3)')).toEqual({ kept: expect.stringMatching(/empty/) })
  })

  it('the _xlfn./_xlws. prefixes files carry are read', () => {
    expect(ev('_xlfn._xlws.SORT({2;1})')).toEqual([[1], [2]])
    expect(ev('_xlfn.UNIQUE({1;1})')).toEqual(1)
    expect(ev('_xlfn.XLOOKUP(5,B1:B5,A1:A5)')).toBe('Apple')
  })

  it('RANDARRAY draws in range, a new draw every calculation', () => {
    const a = ev('RANDARRAY(2,2,1,6,TRUE)') as number[][]
    expect(a).toHaveLength(2)
    for (const x of a.flat()) expect(Number.isInteger(x) && x >= 1 && x <= 6).toBe(true)
    const r = ev('RAND()') as number
    expect(r >= 0 && r < 1).toBe(true)
    expect(createCalc(openWorkbook(book())).evaluate('D', 'RAND()').value).not.toBe(r)
  })
})

describe('xlsx calc: LET and LAMBDA', () => {
  it.each([
    ['LET(x,1,x+1)', 2],
    ['LET(x,2,y,x*3,x+y)', 8],
    ['_xlfn.LET(_xlpm.x,5,_xlpm.x*2)', 10],
    ['LET(r,A1:A5,ROWS(r))', 5],
    ['LET(x,B1:B5,SUM(x))', 20],
    ['LAMBDA(x,x+1)(3)', 4],
    ['_xlfn.LAMBDA(_xlpm.a,_xlpm.b,_xlpm.a*_xlpm.b)(3,4)', 12],
    ['LAMBDA(a,b,a+b)(1)', e('#VALUE!')],
    ['LAMBDA(x,x)', e('#CALC!')],
    ['LET(f,LAMBDA(x,x*x),f(4))', 16],
    ['Double(21)', 42],
    ['LAMBDA(a,b,IF(ISOMITTED(b),a,a+b))(1,)', 1],
    ['MAP({1,2,3},LAMBDA(v,v*2))', [[2, 4, 6]]],
    ['MAP({1,2},{10,20},LAMBDA(a,b,a+b))', [[11, 22]]],
    ['REDUCE(0,{1,2,3},LAMBDA(a,v,a+v))', 6],
    ['REDUCE(1,B1:B5,LAMBDA(a,v,IF(v>a,v,a)))', 8],
    ['SCAN(0,{1,2,3},LAMBDA(a,v,a+v))', [[1, 3, 6]]],
    ['BYROW({1,2;3,4},LAMBDA(r,SUM(r)))', [[3], [7]]],
    ['BYCOL({1,2;3,4},LAMBDA(c,SUM(c)))', [[4, 6]]],
    ['BYROW({1,2;3,4},LAMBDA(r,r))', e('#CALC!')],
    [
      'MAKEARRAY(2,3,LAMBDA(r,c,r*c))',
      [
        [1, 2, 3],
        [2, 4, 6],
      ],
    ],
    ['_xlfn.MAKEARRAY(1,2,_xlfn.LAMBDA(_xlpm.r,_xlpm.c,_xlpm.c))', [[1, 2]]],
  ])('=%s → %j', (formula, value) => {
    expect(ev(formula)).toEqual(value)
  })
})

describe('xlsx calc: arrays lift through operators and scalar functions', () => {
  it.each([
    ['B1:B3*2', [[10], [6], [16]]],
    ['SUM(B1:B5*C1:C5)', 5 * 1.2 + 3 * 0.5 + 8 * 3 + 3 * 2.5 + 4],
    ['LEN(A1:A2)', [[5], [6]]],
    ['IF(B1:B3>4,"big","small")', [['big'], ['small'], ['big']]],
    ['ROW(B2:B4)', [[2], [3], [4]]],
    ['TEXT({0.5,0.25},"0%")', [['50%', '25%']]],
  ])('=%s → %j', (formula, value) => {
    expect(ev(formula)).toEqual(value)
  })
})
