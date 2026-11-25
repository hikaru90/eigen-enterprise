import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { cfRulesOf } from './cond-format'
import { createSheetEditor } from './editor'
import { checkName, listNames } from './names'
import { cellKey } from './ref'
import { buildXlsx, fml, num, row } from './test-utils/build-xlsx'
import { validationsOf } from './validation'
import { openWorkbook } from './workbook'

const bookXml = (b: Uint8Array) => strFromU8(unzipSync(b)['xl/workbook.xml']!)

describe('defined names (Name Manager)', () => {
  it('adds, lists, updates and deletes workbook and sheet-scoped names, and preserves built-ins read-only', () => {
    const bytes = buildXlsx({
      definedNames:
        '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">S!$A$1:$B$2</definedName>',
      sheets: [
        { name: 'S', rows: row(1, num('A1', 10) + num('B1', 20) + fml('C1', 'SUM(Costs)', 0)) },
        {
          name: 'Other',
          rows: row(1, num('A1', 100) + fml('B1', 'SUM(Costs)+1', 0) + fml('C1', 'S!LocalRate', 0)),
        },
      ],
    })
    const ed = createSheetEditor(bytes)
    ed.apply({ op: 'name_add', name: 'Costs', refersTo: '=S!$A$1:$B$1', comment: 'All costs' })
    ed.apply({ op: 'name_add', name: 'LocalRate', refersTo: '=0.19', scope: 'S' })
    // Same name in another sheet's scope is allowed.
    ed.apply({ op: 'name_add', name: 'LocalRate', refersTo: '=0.07', scope: 'Other' })

    const out = ed.toBytes()
    expect(bookXml(out)).toContain('localSheetId="0"')
    const ed2 = createSheetEditor(out)
    expect(ed2.calc().cell('S', 0, 2).value).toBe(30)
    expect(ed2.calc().cell('Other', 0, 1).value).toBe(31)

    const listed = listNames(ed2.wb)
    expect(listed.map((n) => [n.name, n.scope, n.builtIn])).toEqual([
      ['_xlnm._FilterDatabase', 'S', true],
      ['Costs', null, false],
      ['LocalRate', 'S', false],
      ['LocalRate', 'Other', false],
    ])
    expect(listed[1]).toMatchObject({
      refersTo: '=S!$A$1:$B$1',
      comment: 'All costs',
      hidden: false,
    })

    // Built-in names cannot be edited or deleted directly.
    expect(() =>
      ed2.apply({
        op: 'name_update',
        name: '_xlnm._FilterDatabase',
        scope: 'S',
        refersTo: '=S!A1',
      }),
    ).toThrow(/Excel’s own name/)
    expect(() =>
      ed2.apply({ op: 'name_delete', name: '_xlnm._FilterDatabase', scope: 'S' }),
    ).toThrow(/Excel’s own name/)

    // Delete a name -> formulas referencing it become #NAME?.
    ed2.apply({ op: 'name_delete', name: 'LocalRate', scope: 'Other' })
    expect(listNames(ed2.wb).filter((n) => n.name === 'LocalRate')).toHaveLength(1)
    ed2.apply({ op: 'name_delete', name: 'Costs' })
    expect(ed2.calc().cell('S', 0, 2).value).toEqual({ error: '#NAME?' })
  })

  it('renaming a name rewrites formulas across cells, CF, validations and other names while respecting scope shadowing', () => {
    const bytes = buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: row(1, num('A1', 5) + fml('B1', 'Tax*2', 10)),
        },
        {
          name: 'Shadow',
          rows: row(1, num('A1', 3) + fml('B1', 'Tax*2', 6)),
        },
      ],
    })
    const ed = createSheetEditor(bytes)
    ed.apply({ op: 'name_add', name: 'Tax', refersTo: '=S!$A$1' })
    ed.apply({ op: 'name_add', name: 'Tax', scope: 'Shadow', refersTo: '=Shadow!$A$1' })
    ed.apply({ op: 'name_add', name: 'DoubleTax', refersTo: '=Tax*2' })
    ed.apply({
      op: 'cf_add',
      sheet: 'S',
      range: 'A1',
      rule: { type: 'cellIs', operator: 'equal', formula1: '=Tax', style: { bold: true } },
    })
    ed.apply({
      op: 'validation_set',
      sheet: 'S',
      range: 'B1',
      rule: { type: 'whole', operator: 'greaterThan', formula1: '=Tax' },
    })

    // Rename workbook-scoped Tax -> Vat; Shadow's sheet-scoped Tax must stay untouched!
    ed.apply({ op: 'name_update', name: 'Tax', newName: 'Vat', refersTo: '=S!$A$1+1' })
    const wb = openWorkbook(ed.toBytes())
    expect(wb.sheet('S').cells.get(cellKey(0, 1))?.formula).toBe('Vat*2')
    expect(wb.sheet('Shadow').cells.get(cellKey(0, 1))?.formula).toBe('Tax*2')
    expect(listNames(wb).find((n) => n.name === 'DoubleTax')?.refersTo).toBe('=Vat*2')
    expect(cfRulesOf(wb, 'S')[0]!.formulas[0]).toBe('=Vat')
    expect(validationsOf(wb, 'S')[0]!.formula1).toBe('=Vat')

    // Rename Shadow's sheet-scoped Tax -> LocalTax; Shadow's formula updates, S stays Vat.
    const ed2 = createSheetEditor(ed.toBytes())
    ed2.apply({ op: 'name_update', name: 'Tax', scope: 'Shadow', newName: 'LocalTax' })
    expect(ed2.wb.sheet('Shadow').cells.get(cellKey(0, 1))?.formula).toBe('LocalTax*2')
    expect(ed2.wb.sheet('S').cells.get(cellKey(0, 1))?.formula).toBe('Vat*2')
  })

  it('enforces Excel name validation rules and case-insensitive uniqueness per scope', () => {
    expect(checkName('  Revenue_2026.Q1 ')).toBe('Revenue_2026.Q1')
    expect(() => checkName('')).toThrow(/empty/)
    expect(() => checkName('1bad')).toThrow(/not a valid name/)
    expect(() => checkName('has space')).toThrow(/not a valid name/)
    expect(() => checkName('A1')).toThrow(/cell reference/)
    expect(() => checkName('XFD1048576')).toThrow(/cell reference/)
    expect(() => checkName('R1C1')).toThrow(/cell reference/)
    expect(() => checkName('C')).toThrow(/cell reference/)
    expect(() => checkName('_xlnm.Print_Area')).toThrow(/keeps for itself/)

    const ed = createSheetEditor(buildXlsx({ sheets: [{ name: 'S' }] }))
    ed.apply({ op: 'name_add', name: 'Rate', refersTo: '=1' })
    expect(() => ed.apply({ op: 'name_add', name: 'rate', refersTo: '=2' })).toThrow(
      /already a name/,
    )
  })
})
