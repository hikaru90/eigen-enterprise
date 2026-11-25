import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { hyperlinksOf, linkAt, openableUrl, parseTarget, resolvePlace } from './hyperlinks'
import { cellKey } from './ref'
import { buildXlsx, fml, num, row, str } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

const parts = (b: Uint8Array) => unzipSync(b)
const sheetXml = (b: Uint8Array, n = 1) => strFromU8(parts(b)[`xl/worksheets/sheet${n}.xml`]!)
const relsXml = (b: Uint8Array, n = 1) =>
  strFromU8(parts(b)[`xl/worksheets/_rels/sheet${n}.xml.rels`]!)

describe('hyperlinks: external URLs, mailto, internal places and HYPERLINK()', () => {
  it('sets, round-trips and removes web, mailto and internal sheet/name links', () => {
    const bytes = buildXlsx({
      strings: ['Existing'],
      definedNames: '<definedName name="TargetRange">Other!$C$4:$C$5</definedName>',
      sheets: [
        { name: 'Main', rows: row(1, str('A1', 0) + num('B1', 10)) },
        { name: 'Other', rows: row(1, num('A1', 1)) },
      ],
    })
    const ed = createSheetEditor(bytes)
    ed.apply({
      op: 'hyperlink_set',
      sheet: 'Main',
      range: 'A2',
      target: 'https://example.com/docs',
      tooltip: 'Open docs',
      text: 'Docs',
    })
    ed.apply({
      op: 'hyperlink_set',
      sheet: 'Main',
      range: 'B2',
      target: 'team@example.com',
    })
    ed.apply({
      op: 'hyperlink_set',
      sheet: 'Main',
      range: 'C2',
      target: '#Other!B5',
      text: 'Go to Other',
    })
    ed.apply({
      op: 'hyperlink_set',
      sheet: 'Main',
      range: 'D2',
      target: 'TargetRange',
    })
    // Setting a link on A1 (already has "Existing") keeps its existing value when text is omitted.
    ed.apply({
      op: 'hyperlink_set',
      sheet: 'Main',
      range: 'A1',
      target: 'www.example.org',
    })

    const out = ed.toBytes()
    expect(relsXml(out)).toContain('TargetMode="External"')
    expect(sheetXml(out)).toContain('<hyperlinks>')
    expect(parts(out)['xl/theme/theme1.xml']).toEqual(parts(bytes)['xl/theme/theme1.xml'])

    const ed2 = createSheetEditor(out)
    const wb = ed2.wb
    const calc = ed2.calc()
    const links = hyperlinksOf(wb, 'Main')
    expect(links).toHaveLength(5)

    expect(linkAt(wb, calc, 'Main', 1, 0, links)).toEqual({
      target: { kind: 'url', url: 'https://example.com/docs' },
      tooltip: 'Open docs',
    })
    expect(linkAt(wb, calc, 'Main', 1, 1, links)).toEqual({
      target: { kind: 'url', url: 'mailto:team@example.com' },
      tooltip: null,
    })
    expect(linkAt(wb, calc, 'Main', 1, 2, links)).toEqual({
      target: { kind: 'place', location: 'Other!B5' },
      tooltip: null,
    })
    expect(resolvePlace(wb, 'Other!B5', 'Main')).toEqual({
      sheet: 'Other',
      range: { top: 4, bottom: 4, left: 1, right: 1 },
    })
    expect(resolvePlace(wb, 'TargetRange', 'Main')).toEqual({
      sheet: 'Other',
      range: { top: 3, bottom: 4, left: 2, right: 2 },
    })
    expect(wb.sheet('Main').cells.get(cellKey(0, 0))?.value).toBe('Existing')
    expect(wb.sheet('Main').cells.get(cellKey(1, 0))?.value).toBe('Docs')
    expect(wb.sheet('Main').cells.get(cellKey(1, 1))?.value).toBe('team@example.com')
    // Link formatting applied (blue underline).
    expect(wb.styles().xf(wb.sheet('Main').cells.get(cellKey(1, 0))!.style).font).toMatchObject({
      underline: true,
      color: '#0563C1',
    })

    // Removing a link drops the hyperlink + relationship, keeps the cell text & look.
    ed2.apply({ op: 'hyperlink_remove', sheet: 'Main', range: 'A2' })
    const afterRemove = ed2.toBytes()
    const wb3 = openWorkbook(afterRemove)
    expect(hyperlinksOf(wb3, 'Main')).toHaveLength(4)
    expect(wb3.sheet('Main').cells.get(cellKey(1, 0))?.value).toBe('Docs')
    expect(relsXml(afterRemove)).not.toContain('https://example.com/docs')
  })

  it('resolves HYPERLINK() formulas and blocks unsafe schemes', () => {
    const bytes = buildXlsx({
      strings: ['item-42'],
      sheets: [
        {
          name: 'S',
          rows:
            row(
              1,
              str('A1', 0) + fml('B1', 'HYPERLINK("https://ex.com/"&A1,"Open item")', 'Open item'),
            ) +
            row(2, fml('A2', 'HYPERLINK("mailto:hi@ex.com")', 'mailto:hi@ex.com')) +
            row(3, fml('A3', 'HYPERLINK("javascript:alert(1)","Bad")', 'Bad')),
        },
      ],
    })
    const ed = createSheetEditor(bytes)
    const calc = ed.calc()
    expect(linkAt(ed.wb, calc, 'S', 0, 1)).toEqual({
      target: { kind: 'url', url: 'https://ex.com/item-42' },
      tooltip: null,
    })
    expect(linkAt(ed.wb, calc, 'S', 1, 0)).toEqual({
      target: { kind: 'url', url: 'mailto:hi@ex.com' },
      tooltip: null,
    })
    expect(linkAt(ed.wb, calc, 'S', 2, 0)).toBeNull()
    expect(openableUrl('https://ex.com')).toBe(true)
    expect(openableUrl('mailto:a@b.com')).toBe(true)
    expect(openableUrl('javascript:alert(1)')).toBe(false)
    expect(() => parseTarget('javascript:alert(1)')).toThrow(/only web/)
    expect(() => parseTarget('file:///etc/passwd')).toThrow(/only web/)
    expect(() =>
      ed.apply({ op: 'hyperlink_set', sheet: 'S', range: 'C1', target: 'NoSuchSheet!A1' }),
    ).toThrow(/not a cell or a name/)
  })

  it('follows sheet renames and row/column moves and replaces overlapping multi-cell links', () => {
    const bytes = buildXlsx({
      sheets: [{ name: 'Data', rows: row(1, num('A1', 1)) }, { name: 'Dest' }],
    })
    const ed = createSheetEditor(bytes)
    ed.apply({
      op: 'hyperlink_set',
      sheet: 'Data',
      range: 'A1:C1',
      target: 'Dest!B2',
      text: 'Span',
    })
    // Overwriting B1 removes the overlapping A1:C1 link instead of leaving duplicates.
    ed.apply({
      op: 'hyperlink_set',
      sheet: 'Data',
      range: 'B1',
      target: 'https://b1.example',
      text: 'B1',
    })
    expect(hyperlinksOf(ed.wb, 'Data').map((h) => h.ref)).toEqual(['B1'])
    ed.apply({ op: 'hyperlink_set', sheet: 'Data', range: 'A2', target: 'Dest!A1', text: 'Go' })
    ed.apply({ op: 'rename_sheet', sheet: 'Dest', name: 'Target Sheet' })
    ed.apply({ op: 'insert_rows', sheet: 'Data', at: 1, count: 2 })
    const links = hyperlinksOf(openWorkbook(ed.toBytes()), 'Data')
    expect(links.find((l) => l.ref === 'A4')?.target).toEqual({
      kind: 'place',
      location: "'Target Sheet'!A1",
    })
  })
})
