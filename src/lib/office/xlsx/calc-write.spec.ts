import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { toFileFormula, toShownFormula } from './ops'
import { readCells, sheetValues, usedRange } from './read'
import { cellKey } from './ref'
import { buildXlsx, cse, daParts, dyn, num, row } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

/**
 * Dynamic-array formulas written so Excel opens them as spilled formulas
 * (t="array" over the spill range, cell metadata pointing at XLDAPR with
 * fDynamic, the metadata part related from the workbook), not as legacy
 * Ctrl+Shift+Enter arrays; spilled cells written on save.
 */
const xml = (bytes: Uint8Array, name: string) => strFromU8(unzipSync(bytes)[name]!)
const cellXml = (bytes: Uint8Array, ref: string, sheet = 'xl/worksheets/sheet1.xml') =>
  new RegExp(`<c r="${ref}"[^>]*?(/>|>.*?</c>)`).exec(xml(bytes, sheet))?.[0] ?? null
const data = () =>
  buildXlsx({
    sheets: [
      { name: 'S', rows: row(1, num('A1', 3)) + row(2, num('A2', 1)) + row(3, num('A3', 2)) },
    ],
  })

describe('xlsx write: dynamic arrays', () => {
  it('a typed spilling formula is written as a dynamic array with its spill range and values', () => {
    const ed = createSheetEditor(data())
    ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'C1', formula: '=SORT(A1:A3)' }] })
    // Shown in the grid before any save.
    expect([0, 1, 2].map((r) => ed.calc().cell('S', r, 2).value)).toEqual([1, 2, 3])
    const out = ed.toBytes()
    expect(cellXml(out, 'C1')).toBe(
      '<c r="C1" cm="1"><f t="array" ref="C1:C3">_xlfn._xlws.SORT(A1:A3)</f><v>1</v></c>',
    )
    expect(cellXml(out, 'C2')).toBe('<c r="C2"><v>2</v></c>')
    expect(cellXml(out, 'C3')).toBe('<c r="C3"><v>3</v></c>')
    const meta = xml(out, 'xl/metadata.xml')
    expect(meta).toContain('<metadataType name="XLDAPR"')
    expect(meta).toContain('fDynamic="1"')
    expect(meta).toContain('<cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata>')
    expect(xml(out, '[Content_Types].xml')).toContain(
      'PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"',
    )
    expect(xml(out, 'xl/_rels/workbook.xml.rels')).toContain('relationships/sheetMetadata"')
    const back = openWorkbook(out).sheet('S').cells.get(cellKey(0, 2))
    expect(back).toMatchObject({
      formulaType: 'array',
      dynamic: true,
      formula: '_xlfn._xlws.SORT(A1:A3)',
    })
  })

  it('reuses the workbook’s dynamic-array metadata', () => {
    const ed = createSheetEditor(
      buildXlsx({
        ...daParts(),
        sheets: [
          {
            name: 'S',
            rows:
              row(1, num('A1', 1) + dyn('B1', 'B1:B2', '_xlfn.SEQUENCE(2)', 1)) +
              row(2, num('B2', 2)),
          },
        ],
      }),
    )
    ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'D1', formula: 'SEQUENCE(1,2)' }] })
    const out = ed.toBytes()
    expect(cellXml(out, 'D1')).toBe(
      '<c r="D1" cm="1"><f t="array" ref="D1:E1">_xlfn.SEQUENCE(1,2)</f><v>1</v></c>',
    )
    expect(xml(out, 'xl/metadata.xml').match(/XLDAPR/g)).toHaveLength(2)
  })

  it('formulas whose meaning would change in older Excel are written as single-cell dynamic arrays; plain ones stay plain', () => {
    const ed = createSheetEditor(data())
    ed.apply({
      op: 'set_cells',
      sheet: 'S',
      cells: [
        { ref: 'B1', formula: 'A1+A2' },
        { ref: 'B2', formula: 'SUM(A1:A3*2)' },
        { ref: 'B3', formula: 'SUM(A1:A3)' },
        { ref: 'B4', formula: 'XLOOKUP(1,A1:A3,A1:A3)' },
      ],
    })
    const out = ed.toBytes()
    expect(cellXml(out, 'B1')).toBe('<c r="B1"><f>A1+A2</f><v>4</v></c>')
    expect(cellXml(out, 'B2')).toBe(
      '<c r="B2" cm="1"><f t="array" ref="B2">SUM(A1:A3*2)</f><v>12</v></c>',
    )
    expect(cellXml(out, 'B3')).toBe('<c r="B3"><f>SUM(A1:A3)</f><v>6</v></c>')
    expect(cellXml(out, 'B4')).toBe(
      '<c r="B4" cm="1"><f t="array" ref="B4">_xlfn.XLOOKUP(1,A1:A3,A1:A3)</f><v>1</v></c>',
    )
  })

  it('a value typed into a spill blocks it: #SPILL! on save, the old spill cleared', () => {
    const ed = createSheetEditor(data())
    ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'C1', formula: 'SORT(A1:A3)' }] })
    const saved = ed.toBytes()
    const ed2 = createSheetEditor(saved)
    ed2.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'C3', value: 'x' }] })
    expect(ed2.calc().cell('S', 0, 2).value).toEqual({ error: '#SPILL!' })
    expect(ed2.calc().cell('S', 1, 2).value).toBe(null)
    const out = ed2.toBytes()
    expect(cellXml(out, 'C1')).toBe(
      '<c r="C1" cm="1" t="e"><f t="array" ref="C1">_xlfn._xlws.SORT(A1:A3)</f><v>#SPILL!</v></c>',
    )
    expect(cellXml(out, 'C2')).toBe(null)
    expect(cellXml(out, 'C3')).toContain('t="s"')
  })

  it('a spill that shrinks leaves no stale values; replacing the anchor clears its spill', () => {
    const ed = createSheetEditor(data())
    ed.apply({
      op: 'set_cells',
      sheet: 'S',
      cells: [{ ref: 'C1', formula: 'FILTER(A1:A3,A1:A3>0)' }],
    })
    const first = ed.toBytes()
    expect(cellXml(first, 'C3')).toBe('<c r="C3"><v>2</v></c>')
    const ed2 = createSheetEditor(first)
    ed2.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'A2', value: 0 }] })
    const shrunk = ed2.toBytes()
    expect(cellXml(shrunk, 'C1')).toContain('ref="C1:C2"')
    expect(cellXml(shrunk, 'C2')).toBe('<c r="C2"><v>2</v></c>')
    expect(cellXml(shrunk, 'C3')).toBe(null)
    const ed3 = createSheetEditor(shrunk)
    ed3.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'C1', value: 7 }] })
    const replaced = ed3.toBytes()
    expect(cellXml(replaced, 'C1')).toBe('<c r="C1"><v>7</v></c>')
    expect(cellXml(replaced, 'C2')).toBe(null)
  })

  it('legacy array formulas get their recalculated values on save and still refuse partial edits', () => {
    const ed = createSheetEditor(
      buildXlsx({
        sheets: [
          {
            name: 'S',
            rows:
              row(1, num('A1', 1) + cse('B1', 'B1:B2', 'A1:A2*10', 10)) +
              row(2, num('A2', 2) + num('B2', 20)),
          },
        ],
      }),
    )
    ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'A2', value: 5 }] })
    const out = ed.toBytes()
    expect(cellXml(out, 'B1')).toBe('<c r="B1"><f t="array" ref="B1:B2">A1:A2*10</f><v>10</v></c>')
    expect(cellXml(out, 'B2')).toBe('<c r="B2"><v>50</v></c>')
    expect(() =>
      ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'B2', value: 1 }] }),
    ).toThrow(/array formula in B1:B2/)
  })
})

describe('xlsx read: spilled values reach the agent’s reads', () => {
  it('sheet reads include cells a dynamic array spilled into before any save', () => {
    const ed = createSheetEditor(data())
    ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'C1', formula: 'SEQUENCE(4)' }] })
    expect(usedRange(ed, 'S')).toEqual({ top: 0, left: 0, bottom: 3, right: 2 })
    const cells = readCells(ed, 'S', 'C1:C4', 'en', 100).cells
    expect(cells.map((c) => [c.ref, c.value, c.formula ?? null])).toEqual([
      ['C1', 1, '=SEQUENCE(4)'],
      ['C2', 2, null],
      ['C3', 3, null],
      ['C4', 4, null],
    ])
    expect(sheetValues(ed, 'S', 'C3:C4', 'en').rows).toEqual([['3'], ['4']])
  })
})

describe('xlsx write: formula text in the file', () => {
  it.each([
    ['SORT(A1:A3)', '_xlfn._xlws.SORT(A1:A3)'],
    ['FILTER(A1:A3,A1:A3>1)', '_xlfn._xlws.FILTER(A1:A3,A1:A3>1)'],
    ['LET(x,1,x+1)', '_xlfn.LET(_xlpm.x,1,_xlpm.x+1)'],
    ['MAP(A1:A3,LAMBDA(v,v*2))', '_xlfn.MAP(A1:A3,_xlfn.LAMBDA(_xlpm.v,_xlpm.v*2))'],
    ['TEXTSPLIT(A1,",")', '_xlfn.TEXTSPLIT(A1,",")'],
    ['SUM(C1#)', 'SUM(_xlfn.ANCHORARRAY(C1))'],
    ['@A1:A3', '_xlfn.SINGLE(A1:A3)'],
    ['LET(total,1,total)+total', '_xlfn.LET(_xlpm.total,1,_xlpm.total)+total'],
  ])('=%s is written %s and read back the same', (typed, file) => {
    expect(toFileFormula(typed, 'S!A1')).toBe(file)
    expect(toShownFormula(file)).toBe(typed)
  })
})
