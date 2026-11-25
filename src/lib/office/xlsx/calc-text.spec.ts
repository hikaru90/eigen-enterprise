import { describe, expect, it } from 'vitest'
import { createCalc } from './calc'
import { bool, buildXlsx, num, row, txt } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

/**
 * TEXTBEFORE, TEXTAFTER, REGEX*, ARRAYTOTEXT, VALUETOTEXT, ENCODEURL and
 * ADDRESS against the examples of Microsoft's function reference.
 */
const phones = 'Sonia Rees(378) 555-4195\nAngel Brown(878) 555-8622'
const calc = createCalc(
  openWorkbook(
    buildXlsx({
      sheets: [
        {
          name: 'T',
          rows:
            row(2, txt('A2', "Little Red Riding Hood's red hood") + txt('B2', 'Marcus Aurelius') + txt('C2', 'alfalfa') + bool('E2', true) + num('F2', 1234.01234)) +
            row(3, txt('A3', "Little red Riding Hood's red hood") + txt('B3', 'Socrates') + txt('C3', '(378) 555-4195') + txt('E3', 'Seattle') + txt('F3', 'Hello')) +
            row(4, txt('B4', 'Immanuel Kant') + txt('C4', '+1(878) 555-8622')) +
            row(5, txt('C5', 'DylanWilliams')) +
            row(6, txt('C6', 'SoniaBrown')) +
            row(7, txt('C7', phones)),
        },
      ],
    }),
  ),
)
const ev = (formula: string) => {
  const out = calc.evaluate('T', formula, 'H1')
  if (out.kept) return { kept: out.reason }
  return out.array ?? out.value
}
const e = (code: string) => ({ error: code })

describe('xlsx calc: TEXTBEFORE and TEXTAFTER (Microsoft’s examples)', () => {
  it.each([
    ['TEXTBEFORE(A2,"Red")', 'Little '],
    ['TEXTBEFORE(A3,"Red")', e('#N/A')],
    ['TEXTBEFORE(A3,"red",2)', "Little red Riding Hood's "],
    ['TEXTBEFORE(A3,"red",-2)', 'Little '],
    ['TEXTBEFORE(A3,"Red",,FALSE)', e('#N/A')],
    ['TEXTBEFORE(A3,"red",3)', e('#N/A')],
    ['TEXTBEFORE(B2," ",,,1)', 'Marcus'],
    ['TEXTBEFORE(B3," ",,,0)', e('#N/A')],
    ['TEXTBEFORE(B3," ",,,1)', 'Socrates'],
    ['TEXTBEFORE(B4," ",,,1)', 'Immanuel'],
    ['TEXTBEFORE("Red riding hood\'s, red hood","hood")', 'Red riding '],
    ['TEXTBEFORE("Red riding hood\'s, red hood","")', ''],
    ['TEXTBEFORE("Red riding hood\'s, red hood","",-1)', "Red riding hood's, red hood"],
    ['TEXTAFTER(A2,"Red")', " Riding Hood's red hood"],
    ['TEXTAFTER(A2,"basket")', e('#N/A')],
    ['TEXTAFTER(A3,"red",2)', ' hood'],
    ['TEXTAFTER(A3,"red",-2)', " Riding Hood's red hood"],
    ['TEXTAFTER(A3,"Red",,FALSE)', e('#N/A')],
    ['TEXTAFTER(A2,"red",3)', e('#N/A')],
    ['TEXTAFTER(B2," ",,,1)', 'Aurelius'],
    ['TEXTAFTER(B3," ",,,0)', e('#N/A')],
    ['TEXTAFTER(B3," ",,,1)', ''],
    ['IF(TEXTAFTER(B3," ",,,1)="",B3)', 'Socrates'],
    ['TEXTAFTER(B4," ",,,1)', 'Kant'],
  ])('%s', (f, want) => expect(ev(f)).toEqual(want))

  it('follows the documented rules for options and errors', () => {
    expect(ev('TEXTBEFORE(A3,"RED",1,1)')).toBe('Little ')
    expect(ev('TEXTBEFORE("a-b_c",{"_","-"})')).toBe('a')
    expect(ev('TEXTAFTER("a-b_c",{"_","-"},-1)')).toBe('c')
    expect(ev('TEXTBEFORE("abc","b",0)')).toEqual(e('#VALUE!'))
    expect(ev('TEXTBEFORE("abc","b",4)')).toEqual(e('#VALUE!'))
    expect(ev('TEXTBEFORE("abc","x",,,,"none")')).toBe('none')
    expect(ev('TEXTBEFORE("","x")')).toBe('')
    expect(ev('TEXTBEFORE({"a-b";"c-d"},"-")')).toEqual([['a'], ['c']])
  })
})

describe('xlsx calc: REGEXTEST, REGEXEXTRACT, REGEXREPLACE (Microsoft’s examples)', () => {
  it.each([
    ['REGEXTEST(C2,"a")', true],
    ['REGEXTEST(C2,"[a-z]")', true],
    ['REGEXTEST(C2,"[A-Z]")', false],
    ['REGEXTEST(C2,"[aeiou]")', true],
    ['REGEXTEST(C2,"[0-9]")', false],
    ['REGEXTEST(C2,"[A-Z]",1)', true],
    ['REGEXTEST(C3,"^\\([0-9]{3}\\) [0-9]{3}-[0-9]{4}$")', true],
    ['REGEXTEST(C4,"^\\([0-9]{3}\\) [0-9]{3}-[0-9]{4}$")', false],
    ['REGEXEXTRACT(C5,"[A-Z][a-z]+")', 'Dylan'],
    ['REGEXEXTRACT(C5,"[A-Z][a-z]+",1)', [['Dylan'], ['Williams']]],
    ['REGEXEXTRACT(C5,"([A-Z][a-z]+)([A-Z][a-z]+)",2)', [['Dylan', 'Williams']]],
    ['REGEXEXTRACT(C7,"[0-9()]+ [0-9-]+",1)', [['(378) 555-4195'], ['(878) 555-8622']]],
    ['REGEXEXTRACT(C2,"x")', e('#N/A')],
    ['REGEXREPLACE(C7,"[0-9]+-","***-")', 'Sonia Rees(378) ***-4195\nAngel Brown(878) ***-8622'],
    ['REGEXREPLACE(C6,"([A-Z][a-z]+)([A-Z][a-z]+)","$2, $1")', 'Brown, Sonia'],
    ['REGEXREPLACE(C2,"a","A",2)', 'alfAlfa'],
    ['REGEXREPLACE(C2,"a","A",-1)', 'alfalfA'],
    ['REGEXREPLACE(C2,"A","-",0,1)', '-lf-lf-'],
    ['REGEXREPLACE("x","x","$$")', '$'],
  ])('%s', (f, want) => expect(ev(f)).toEqual(want))

  it('refuses what PCRE2 and JavaScript read differently', () => {
    for (const f of [
      'REGEXTEST("aaa","a++")',
      'REGEXTEST("aaa","(?>a)")',
      'REGEXTEST("aaa","(?i)a")',
      'REGEXTEST("aaa","\\Aa")',
      'REGEXTEST("aaa","[[:alpha:]]")',
      'REGEXTEST("aaa","\\p{L}")',
      'REGEXEXTRACT("aaa","b*",1)',
      'REGEXTEST("Ä","ä",1)',
      'REGEXREPLACE("abc","b","$&")',
      'REGEXREPLACE("abc","b","x",3)',
    ])
      expect(ev(f), f).toHaveProperty('kept')
  })
})

describe('xlsx calc: ARRAYTOTEXT, VALUETOTEXT, ENCODEURL, ADDRESS', () => {
  it.each([
    ['ARRAYTOTEXT(E2:F3)', 'TRUE, 1234.01234, Seattle, Hello'],
    ['ARRAYTOTEXT(E2:F3,1)', '{TRUE,1234.01234;"Seattle","Hello"}'],
    ['ARRAYTOTEXT({1,2;3,4},2)', e('#VALUE!')],
    ['VALUETOTEXT(E3)', 'Seattle'],
    ['VALUETOTEXT(E3,1)', '"Seattle"'],
    ['VALUETOTEXT(F2,1)', '1234.01234'],
    ['VALUETOTEXT(1/0)', '#DIV/0!'],
    [
      'ENCODEURL("http://contoso.sharepoint.com/teams/Finance/Documents/April Reports/Profit and Loss Statement.xlsx")',
      'http%3A%2F%2Fcontoso.sharepoint.com%2Fteams%2FFinance%2FDocuments%2FApril%20Reports%2FProfit%20and%20Loss%20Statement.xlsx',
    ],
    ['ADDRESS(2,3)', '$C$2'],
    ['ADDRESS(2,3,2)', 'C$2'],
    ['ADDRESS(2,3,2,FALSE)', 'R2C[3]'],
    ['ADDRESS(2,3,1,FALSE,"[Book1]Sheet1")', "'[Book1]Sheet1'!R2C3"],
    ['ADDRESS(2,3,1,FALSE,"EXCEL SHEET")', "'EXCEL SHEET'!R2C3"],
    ['ADDRESS(0,1)', e('#VALUE!')],
  ])('%s', (f, want) => expect(ev(f)).toEqual(want))
})
