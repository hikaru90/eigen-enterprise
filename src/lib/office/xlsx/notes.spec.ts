import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { readNotes } from './notes'
import { lossesOf } from './ops'
import { buildXlsx, num, row } from './test-utils/build-xlsx'
import { commentBook } from './test-utils/drawing-fixtures'
import { openWorkbook } from './workbook'

const files = (bytes: Uint8Array) => unzipSync(bytes)
const text = (bytes: Uint8Array, name: string) => strFromU8(files(bytes)[name]!)
const notesOf = (bytes: Uint8Array, sheet = 'Notes') => {
  const wb = openWorkbook(bytes)
  return readNotes(wb, wb.requireWorksheet(sheet))
}

describe('cell notes (legacy comments + VML)', () => {
  it('reads notes from Excel comments+VML and skips threaded comment stand-ins', () => {
    const notes = notesOf(commentBook())
    expect(notes).toEqual([
      {
        ref: 'B2',
        row: 1,
        col: 1,
        author: 'Ada Lovelace',
        text: 'Ada Lovelace:\nCheck this number',
        visible: true,
      },
    ])
  })

  it('keeps comments, VML and sheet XML untouched on unrelated edits', () => {
    const before = commentBook()
    const ed = createSheetEditor(before)
    ed.apply({ op: 'set_cells', sheet: 'Notes', cells: [{ ref: 'A6', value: 99 }] })
    let after = ed.toBytes()
    expect(files(after)['xl/comments1.xml']).toEqual(files(before)['xl/comments1.xml'])
    expect(files(after)['xl/drawings/vmlDrawing1.vml']).toEqual(files(before)['xl/drawings/vmlDrawing1.vml'])

    // Editing an existing note updates comments + VML without modifying sheet1.xml
    const ed2 = createSheetEditor(before)
    ed2.apply({ op: 'set_note', sheet: 'Notes', ref: 'B2', text: 'Updated note', visible: false })
    after = ed2.toBytes()
    expect(files(after)['xl/worksheets/sheet1.xml']).toEqual(files(before)['xl/worksheets/sheet1.xml'])
    expect(notesOf(after)).toEqual([
      { ref: 'B2', row: 1, col: 1, author: 'Ada Lovelace', text: 'Updated note', visible: false },
    ])
  })

  it('creates a note on a plain sheet with comments, VML idmap/shape and <legacyDrawing>, and removes empty parts + undo', () => {
    const ed = createSheetEditor(commentBook())
    ed.apply({ op: 'set_note', sheet: 'Plain', ref: 'C3', text: 'Check total', author: 'Grace', visible: true })
    let out = ed.toBytes()
    expect(notesOf(out, 'Plain')).toEqual([
      { ref: 'C3', row: 2, col: 2, author: 'Grace', text: 'Check total', visible: true },
    ])
    const sheetXml = text(out, 'xl/worksheets/sheet2.xml')
    expect(sheetXml).toMatch(/<legacyDrawing r:id="rId\d+"\/>/)
    const vml = text(out, 'xl/drawings/vmlDrawing2.vml')
    expect(vml).toContain('o:idmap v:ext="edit" data="2"')
    expect(vml).toContain('ObjectType="Note"')
    expect(vml).toContain('<x:Visible/>')
    expect(text(out, '[Content_Types].xml')).toContain('PartName="/xl/drawings/vmlDrawing2.vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"')

    // Toggle Show Note off, then delete the note and assert cleanup + undo restore
    ed.apply({ op: 'set_note', sheet: 'Plain', ref: 'C3', visible: false })
    expect(notesOf(ed.toBytes(), 'Plain')[0]!.visible).toBe(false)

    ed.apply({ op: 'delete_note', sheet: 'Plain', ref: 'C3' })
    out = ed.toBytes()
    expect(notesOf(out, 'Plain')).toEqual([])
    expect(files(out)['xl/comments2.xml']).toBeUndefined()
    expect(files(out)['xl/drawings/vmlDrawing2.vml']).toBeUndefined()
    expect(text(out, 'xl/worksheets/sheet2.xml')).not.toContain('legacyDrawing')

    ed.undo()
    out = ed.toBytes()
    expect(notesOf(out, 'Plain')).toEqual([
      { ref: 'C3', row: 2, col: 2, author: 'Grace', text: 'Check total', visible: false },
    ])
    expect(files(out)['xl/drawings/vmlDrawing2.vml']).toBeDefined()
  })

  it('refuses invalid refs, empty or oversized text, missing notes and cells with a threaded comment', () => {
    const ed = createSheetEditor(commentBook())
    expect(() => ed.apply({ op: 'set_note', sheet: 'Notes', ref: 'bad', text: 'x' })).toThrow(/cell address/)
    expect(() => ed.apply({ op: 'set_note', sheet: 'Notes', ref: 'D4', text: '   ' })).toThrow(/needs text/)
    expect(() => ed.apply({ op: 'set_note', sheet: 'Notes', ref: 'D4', text: 'a'.repeat(32_768) })).toThrow(/32767/)
    expect(() => ed.apply({ op: 'set_note', sheet: 'Notes', ref: 'D4', visible: true })).toThrow(/has no note yet/)
    expect(() => ed.apply({ op: 'delete_note', sheet: 'Notes', ref: 'D4' })).toThrow(/has no note/)
    expect(() => ed.apply({ op: 'set_note', sheet: 'Notes', ref: 'C4', text: 'conflict' })).toThrow(/comment thread/)
  })

  it('moves notes on row/col insert, deletes them cleanly on row/col deletion, and follows row sorts without reporting a loss', () => {
    const ed = createSheetEditor(commentBook())
    const insOp = { op: 'insert_rows', sheet: 'Notes', at: 1, count: 2 } as const
    expect(lossesOf(ed.wb, insOp).map((l) => l.feature)).not.toContain('comments')
    ed.apply(insOp)
    expect(notesOf(ed.toBytes())[0]).toMatchObject({ ref: 'B4', row: 3, col: 1 })
    expect(text(ed.toBytes(), 'xl/drawings/vmlDrawing1.vml')).toContain('<x:Row>3</x:Row>')

    ed.apply({ op: 'insert_columns', sheet: 'Notes', at: 0, count: 1 })
    expect(notesOf(ed.toBytes())[0]).toMatchObject({ ref: 'C4', row: 3, col: 2 })
    expect(text(ed.toBytes(), 'xl/drawings/vmlDrawing1.vml')).toContain('<x:Column>2</x:Column>')

    ed.apply({ op: 'delete_rows', sheet: 'Notes', at: 3, count: 1 })
    expect(notesOf(ed.toBytes())).toEqual([])

    // Row sorting moves notes with their rows without reporting a comments loss
    const sortBytes = buildXlsx({
      sheets: [{ name: 'S', rows: row(1, num('A1', 30)) + row(2, num('A2', 10)) }],
    })
    const sortEd = createSheetEditor(sortBytes)
    sortEd.apply({ op: 'set_note', sheet: 'S', ref: 'A1', text: 'Thirty' })
    sortEd.apply({ op: 'set_note', sheet: 'S', ref: 'A2', text: 'Ten' })
    const sortOp = { op: 'sort_range', sheet: 'S', range: 'A1:A2', header: false, keys: [{ col: 0 }] } as const
    expect(lossesOf(sortEd.wb, sortOp).map((l) => l.feature)).not.toContain('comments')
    sortEd.apply(sortOp)
    expect(notesOf(sortEd.toBytes(), 'S')).toEqual([
      { ref: 'A2', row: 1, col: 0, author: '', text: 'Thirty', visible: false },
      { ref: 'A1', row: 0, col: 0, author: '', text: 'Ten', visible: false },
    ])
  })
})
