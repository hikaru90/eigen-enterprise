import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import {
  cellProtectionReader,
  legacyPasswordHash,
  sha512PasswordHash,
  sheetProtectionOf,
  workbookProtectionOf,
} from './protection'
import { sha512 } from './sha512'
import { buildXlsx, num, row, STYLES } from './test-utils/build-xlsx'
import { openWorkbook } from './workbook'

const sheetXml = (b: Uint8Array) => strFromU8(unzipSync(b)['xl/worksheets/sheet1.xml']!)
const bookXml = (b: Uint8Array) => strFromU8(unzipSync(b)['xl/workbook.xml']!)

/** Styles with an unlocked cell format (xf 5: protection locked="0"). */
const UNLOCKED_STYLES = STYLES.replace('<cellXfs count="5">', '<cellXfs count="6">').replace(
  '</cellXfs>',
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf></cellXfs>',
)

function book(protection = '', wbProtection = '') {
  const bytes = buildXlsx({
    sheets: [
      {
        name: 'S',
        rows: row(1, num('A1', 1) + num('B1', 2, 5)) + row(2, num('A2', 3)),
        after: protection,
      },
      { name: 'T' },
    ],
  })
  // Swap in the styles with the unlocked format, and the workbook protection.
  const files = unzipSync(bytes)
  files['xl/styles.xml'] = new TextEncoder().encode(UNLOCKED_STYLES)
  if (wbProtection)
    files['xl/workbook.xml'] = new TextEncoder().encode(
      strFromU8(files['xl/workbook.xml']!).replace('<bookViews>', `${wbProtection}<bookViews>`),
    )
  // sheetProtection belongs right after sheetData (CT_Worksheet order).
  if (protection) {
    const s = strFromU8(files['xl/worksheets/sheet1.xml']!).replace(protection, '')
    files['xl/worksheets/sheet1.xml'] = new TextEncoder().encode(
      s.replace('</sheetData>', `</sheetData>${protection}`),
    )
  }
  return import('fflate').then(({ zipSync }) => zipSync(files))
}

describe('SHA-512 (FIPS 180-4)', () => {
  it('matches the standard test vectors and node:crypto', () => {
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
    expect(hex(sha512(new TextEncoder().encode('abc')))).toBe(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    )
    for (const n of [0, 55, 111, 112, 127, 128, 200, 1000]) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff)
      expect(hex(sha512(data))).toBe(createHash('sha512').update(data).digest('hex'))
    }
  })
})

describe('Excel password hashes', () => {
  it('computes the legacy 16-bit verifier (as Excel and other implementations write it)', () => {
    expect(legacyPasswordHash('secret')).toBe('DAA7')
    expect(legacyPasswordHash('password')).toBe('83AF')
    expect(legacyPasswordHash('test')).toBe('CBEB')
  })

  it('computes the SHA-512 spin hash: H(salt + UTF-16LE password), then H(hash + LE32 i) spinCount times', () => {
    // Reference computed independently (Python hashlib) for salt 00 01 … 0F, 100000 spins.
    expect(sha512PasswordHash('secret', 'AAECAwQFBgcICQoLDA0ODw==', 100_000)).toBe(
      'M5SOVnbQG4SHyBnRVAYzAx8mPtxyyzMuWxcMv7tkyFO3MBXX9OJjklwPglNHdoHVkKPm4MPfUblqHmAsXfF5HA==',
    )
  })
})

describe('sheet protection', () => {
  it('reads Excel’s sheetProtection with its defaults (true = not allowed)', async () => {
    const wb = openWorkbook(
      await book('<sheetProtection sheet="1" objects="1" scenarios="1" formatCells="0" sort="0"/>'),
    )
    const p = sheetProtectionOf(wb, 'S')!
    expect(p.hasPassword).toBe(false)
    expect(p.allow.formatCells).toBe(true)
    expect(p.allow.sort).toBe(true)
    expect(p.allow.insertRows).toBe(false)
    expect(p.allow.selectLockedCells).toBe(true)
    expect(sheetProtectionOf(wb, 'T')).toBeNull()
  })

  it('refuses typing into locked cells and allows unlocked ones, with the reason', async () => {
    const ed = createSheetEditor(
      await book('<sheetProtection sheet="1" objects="1" scenarios="1"/>'),
    )
    expect(() =>
      ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'A1', value: 9 }] }),
    ).toThrow(/S!A1 is locked and the sheet is protected/)
    ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'B1', value: 9 }] })
    expect(cellProtectionReader(ed.wb, 'S')(0, 1).locked).toBe(false)
    // Not allowed by the protection: formatting, inserting rows; allowed: freeze panes (a view).
    expect(() =>
      ed.apply({ op: 'set_style', sheet: 'S', range: 'B1', style: { bold: true } }),
    ).toThrow(/protected: you can’t format cells/)
    expect(() => ed.apply({ op: 'insert_rows', sheet: 'S', at: 0, count: 1 })).toThrow(
      /insert rows/,
    )
    ed.apply({ op: 'freeze_panes', sheet: 'S', rows: 1, cols: 0 })
    // Other sheets are not protected.
    ed.apply({ op: 'set_cells', sheet: 'T', cells: [{ ref: 'A1', value: 1 }] })
  })

  it('protects with a SHA-512 password as Excel writes it, and unprotects only with it', async () => {
    const ed = createSheetEditor(await book())
    ed.apply({ op: 'protect_sheet', sheet: 'S', password: 'pw', allow: { formatCells: true } })
    const xml = sheetXml(ed.toBytes())
    expect(xml).toMatch(
      /<sheetProtection algorithmName="SHA-512" hashValue="[A-Za-z0-9+/=]{88}" saltValue="[A-Za-z0-9+/=]{24}" spinCount="100000" sheet="1" objects="1" scenarios="1" formatCells="0"\/><\/?\w/,
    )
    expect(xml).not.toContain('pw"')
    expect(xml.indexOf('<sheetProtection')).toBeGreaterThan(xml.indexOf('</sheetData>'))
    expect(() => ed.apply({ op: 'unprotect_sheet', sheet: 'S' })).toThrow(/with a password/)
    expect(() => ed.apply({ op: 'unprotect_sheet', sheet: 'S', password: 'nope' })).toThrow(
      /password is not correct/,
    )
    ed.apply({ op: 'unprotect_sheet', sheet: 'S', password: 'pw' })
    expect(sheetXml(ed.toBytes())).not.toContain('sheetProtection')
  })

  it('unprotects a file protected with the legacy hash', async () => {
    const ed = createSheetEditor(
      await book(`<sheetProtection password="${legacyPasswordHash('old')}" sheet="1"/>`),
    )
    expect(sheetProtectionOf(ed.wb, 'S')!.hasPassword).toBe(true)
    expect(() => ed.apply({ op: 'unprotect_sheet', sheet: 'S', password: 'x' })).toThrow()
    ed.apply({ op: 'unprotect_sheet', sheet: 'S', password: 'old' })
    expect(sheetProtectionOf(ed.wb, 'S')).toBeNull()
  })

  it('locks and unlocks cells (Format Cells ▸ Protection) as a copy of their format', async () => {
    const ed = createSheetEditor(await book())
    ed.apply({ op: 'set_cell_protection', sheet: 'S', range: 'A1:A2', locked: false, hidden: true })
    const read = cellProtectionReader(ed.wb, 'S')
    expect(read(0, 0)).toEqual({ locked: false, hidden: true })
    expect(read(2, 0)).toEqual({ locked: true, hidden: false })
    ed.apply({ op: 'set_cell_protection', sheet: 'S', range: 'A1', locked: true, hidden: false })
    expect(cellProtectionReader(ed.wb, 'S')(0, 0)).toEqual({ locked: true, hidden: false })
  })

  it('keeps editable ranges without a password editable on a protected sheet', async () => {
    const ed = createSheetEditor(
      await book(
        '<sheetProtection sheet="1"/><protectedRanges><protectedRange name="In" sqref="A2"/></protectedRanges>',
      ),
    )
    ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'A2', value: 5 }] })
    expect(() =>
      ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'A1', value: 5 }] }),
    ).toThrow(/locked/)
  })
})

describe('workbook protection', () => {
  it('a locked structure refuses adding, renaming and deleting sheets', async () => {
    const ed = createSheetEditor(await book('', '<workbookProtection lockStructure="1"/>'))
    expect(workbookProtectionOf(ed.wb)).toEqual({
      structure: true,
      windows: false,
      hasPassword: false,
    })
    expect(() => ed.apply({ op: 'add_sheet', name: 'X' })).toThrow(/structure is protected/)
    expect(() => ed.apply({ op: 'rename_sheet', sheet: 'T', name: 'X' })).toThrow(/structure/)
    // Cells are not affected by the workbook's protection.
    ed.apply({ op: 'set_cells', sheet: 'S', cells: [{ ref: 'A1', value: 2 }] })
  })

  it('protects the structure with a password in workbook order and unprotects with it', async () => {
    const ed = createSheetEditor(await book())
    ed.apply({ op: 'protect_workbook', password: 'b00k' })
    const xml = bookXml(ed.toBytes())
    expect(xml).toMatch(
      /<workbookPr\/><workbookProtection workbookAlgorithmName="SHA-512" workbookHashValue="[^"]+" workbookSaltValue="[^"]+" workbookSpinCount="100000" lockStructure="1"\/><bookViews>/,
    )
    expect(() => ed.apply({ op: 'unprotect_workbook', password: 'wrong' })).toThrow(/not correct/)
    ed.apply({ op: 'unprotect_workbook', password: 'b00k' })
    expect(workbookProtectionOf(ed.wb)).toBeNull()
    ed.apply({ op: 'add_sheet', name: 'X' })
  })
})
