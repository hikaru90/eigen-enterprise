import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { cellKey } from './ref'
import { buildXlsx, fml, num, row, str } from './test-utils/build-xlsx'
import {
  checkWrites,
  hasDropdown,
  invalidCells,
  listItems,
  validationAt,
  validationReader,
  validationsOf,
} from './validation'
import { openWorkbook } from './workbook'

const parts = (b: Uint8Array) => unzipSync(b)
const sheetXml = (b: Uint8Array, n = 1) => strFromU8(parts(b)[`xl/worksheets/sheet${n}.xml`]!)

describe('data validation: list (inline, range, cross-sheet, name, dropdown)', () => {
  it('round-trips inline lists and range/cross-sheet/named list sources, evaluates and hides/shows dropdown', () => {
    const bytes = buildXlsx({
      strings: ['Red', 'Green', 'Blue', 'Cyan', 'Magenta'],
      definedNames: '<definedName name="Colors">Lists!$A$1:$A$2</definedName>',
      sheets: [
        { name: 'S', rows: row(1, str('A1', 0) + str('B1', 3) + str('C1', 0)) },
        { name: 'Lists', rows: row(1, str('A1', 3)) + row(2, str('A2', 4)) },
      ],
    })
    const ed = createSheetEditor(bytes)
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'A1:A5',
      rule: {
        type: 'list',
        items: ['Red', 'Green', 'Blue'],
        inputTitle: 'Pick a colour',
        inputMessage: 'Choose from the list.',
        errorStyle: 'stop',
        errorTitle: 'Invalid',
        errorMessage: 'Must be RGB.',
      },
    })
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'B1',
      rule: { type: 'list', formula1: '=Colors', dropdown: false },
    })
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'C1',
      rule: { type: 'list', formula1: '=Lists!$A$1:$A$2', errorStyle: 'warning' },
    })

    const out = ed.toBytes()
    expect(sheetXml(out)).toContain('showDropDown="1"')
    expect(parts(out)['xl/theme/theme1.xml']).toEqual(parts(bytes)['xl/theme/theme1.xml'])

    const ed2 = createSheetEditor(out)
    const calc = ed2.calc()
    const rules = validationsOf(ed2.wb, 'S')
    expect(rules).toHaveLength(3)
    expect(hasDropdown(rules, 0, 0)).toBe(true)
    expect(hasDropdown(rules, 0, 1)).toBe(false)
    expect(listItems(ed2.wb, calc, 'S', rules[0]!, 0, 0)).toEqual(['Red', 'Green', 'Blue'])
    expect(listItems(ed2.wb, calc, 'S', rules[1]!, 0, 1)).toEqual(['Cyan', 'Magenta'])
    expect(listItems(ed2.wb, calc, 'S', rules[2]!, 0, 2)).toEqual(['Cyan', 'Magenta'])
    expect(rules[0]).toMatchObject({
      inputTitle: 'Pick a colour',
      inputMessage: 'Choose from the list.',
      errorStyle: 'stop',
      errorTitle: 'Invalid',
      errorMessage: 'Must be RGB.',
    })

    // Check writes: valid passes (case-insensitive), invalid triggers alert without mutating workbook.
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'A2', value: 'green' }])).toEqual([])
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'A2', value: 'Yellow' }])).toEqual([
      {
        ref: 'A2',
        errorStyle: 'stop',
        title: 'Invalid',
        message: 'Must be RGB.',
        silent: false,
      },
    ])
    expect(ed2.wb.sheet('S').cells.get(cellKey(1, 0))).toBeUndefined()
    // Warning alert on C1.
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'C1', value: 'Nope' }])).toEqual([
      { ref: 'C1', errorStyle: 'warning', title: null, message: null, silent: false },
    ])
    // Clearing is never refused.
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'A1', value: null }])).toEqual([])
  })

  it('reads and clears Excel 2010 x14 extension dataValidations', () => {
    const bytes = buildXlsx({
      strings: ['One', 'Two'],
      sheets: [
        {
          name: 'S',
          after:
            '<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1"><x14:formula1><xm:f>Lists!$A$1:$A$2</xm:f></x14:formula1><xm:sqref>B2:B4</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>',
        },
        { name: 'Lists', rows: row(1, str('A1', 0)) + row(2, str('A2', 1)) },
      ],
    })
    const ed = createSheetEditor(bytes)
    const rules = validationsOf(ed.wb, 'S')
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      extension: true,
      sqref: 'B2:B4',
      formula1: '=Lists!$A$1:$A$2',
    })
    expect(listItems(ed.wb, ed.calc(), 'S', rules[0]!, 1, 1)).toEqual(['One', 'Two'])
    ed.apply({ op: 'validation_clear', sheet: 'S', range: 'B3' })
    const left = validationsOf(ed.wb, 'S')
    expect(left[0]!.sqref).toBe('B2 B4')
  })
})

describe('data validation: whole, decimal, date, time, textLength, custom, alerts and invalid circles', () => {
  it('checks all numeric/date/time/textLength/custom rules, operators and alert styles', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows:
            row(
              1,
              num('A1', 5) + num('B1', 1.5) + num('C1', 46000) + num('D1', 0.5) + num('E1', 100),
            ) + row(2, num('A2', 10) + num('B2', 10) + fml('C2', '10+1', 11)),
        },
      ],
    })
    const ed = createSheetEditor(bytes)
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'A1',
      rule: {
        type: 'whole',
        operator: 'between',
        formula1: '1',
        formula2: '10',
        errorStyle: 'stop',
      },
    })
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'B1',
      rule: {
        type: 'decimal',
        operator: 'greaterThan',
        formula1: '1.2',
        errorStyle: 'information',
      },
    })
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'C1',
      rule: { type: 'date', operator: 'between', formula1: '2026-01-01', formula2: '2026-12-31' },
    })
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'D1',
      rule: { type: 'time', operator: 'lessThanOrEqual', formula1: '12:00' },
    })
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'E1',
      rule: { type: 'textLength', operator: 'equal', formula1: '4', showError: false },
    })
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'A2:C2',
      rule: { type: 'custom', formula1: '=A2<20', allowBlank: false },
    })

    const out = ed.toBytes()
    const ed2 = createSheetEditor(out)
    // Whole rejects decimals and out-of-range.
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'A1', value: 5.5 }])).toHaveLength(1)
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'A1', value: 5 }])).toEqual([])
    // Decimal information alert.
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'B1', value: 1.0 }])).toMatchObject([
      { ref: 'B1', errorStyle: 'information', silent: false },
    ])
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'B1', value: 2.5 }])).toEqual([])
    // Date checks serial parsed from 2026-01-01..2026-12-31.
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'C1', value: 46143 }])).toEqual([])
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'C1', value: 45000 }])).toHaveLength(1)
    // Time <= 0.5 (12:00).
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'D1', value: 0.25 }])).toEqual([])
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'D1', value: 0.75 }])).toHaveLength(1)
    // Silent alert when showError is false.
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'E1', value: 'abc' }])).toMatchObject([
      { ref: 'E1', silent: true },
    ])
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'E1', value: 'abcd' }])).toEqual([])
    // Custom formula evaluates translated per cell and checks formula results.
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'B2', formula: '=5+20' }])).toHaveLength(1)
    expect(checkWrites(ed2.wb, 'S', [{ ref: 'B2', formula: '=5+10' }])).toEqual([])

    // Circle invalid data lists existing cells failing their rule: C1 (46000 < 2026-01-01) and E1 ("100" length 3 != 4).
    const invalid = invalidCells(ed2.wb, ed2.calc(), 'S')
    expect(invalid).toEqual(['C1', 'E1'])
    const reader = validationReader(ed2.wb, ed2.calc(), 'S')
    expect(reader.invalid(0, 2)).toBe(true)
    expect(reader.invalid(0, 0)).toBe(false)
    expect(validationAt(reader.rules, 1, 2)?.type).toBe('custom')
  })

  it('supports remaining numeric operators, partial clearing, row insertion and refuses invalid inputs', () => {
    const bytes = buildXlsx({ sheets: [{ name: 'S', rows: row(1, num('A1', 10)) }] })
    for (const [op, f1, f2, ok, bad] of [
      ['notBetween', '5', '10', 4, 7],
      ['notEqual', '5', undefined, 6, 5],
      ['lessThan', '5', undefined, 4, 5],
      ['greaterThanOrEqual', '5', undefined, 5, 4],
    ] as const) {
      const ed = createSheetEditor(bytes)
      ed.apply({
        op: 'validation_set',
        sheet: 'S',
        range: 'A1',
        rule: { type: 'whole', operator: op, formula1: f1, ...(f2 ? { formula2: f2 } : {}) },
      })
      expect(checkWrites(ed.wb, 'S', [{ ref: 'A1', value: ok }])).toEqual([])
      expect(checkWrites(ed.wb, 'S', [{ ref: 'A1', value: bad }])).toHaveLength(1)
    }

    const ed = createSheetEditor(bytes)
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'A1:B3',
      rule: { type: 'whole', operator: 'greaterThan', formula1: '0' },
    })
    ed.apply({ op: 'insert_rows', sheet: 'S', at: 0, count: 1 })
    expect(validationsOf(ed.wb, 'S')[0]!.sqref).toBe('A2:B4')
    ed.apply({ op: 'validation_clear', sheet: 'S', range: 'A2:B3' })
    expect(validationsOf(openWorkbook(ed.toBytes()), 'S')[0]!.sqref).toBe('A4:B4')

    expect(() =>
      ed.apply({
        op: 'validation_set',
        sheet: 'S',
        range: 'A1',
        rule: { type: 'list', items: ['a,b'] },
      }),
    ).toThrow(/comma/)
    expect(() =>
      ed.apply({
        op: 'validation_set',
        sheet: 'S',
        range: 'A1',
        rule: { type: 'list', items: ['x'.repeat(256)] },
      }),
    ).toThrow(/255/)
    expect(() =>
      ed.apply({
        op: 'validation_set',
        sheet: 'S',
        range: 'A1',
        rule: { type: 'whole', operator: 'between', formula1: '1' },
      }),
    ).toThrow(/maximum/)
    expect(() =>
      ed.apply({
        op: 'validation_set',
        sheet: 'S',
        range: 'A1',
        rule: { type: 'whole', formula1: '1', inputTitle: 'x'.repeat(33) },
      }),
    ).toThrow(/32/)
  })
})
