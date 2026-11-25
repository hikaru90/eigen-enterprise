import { describe, expect, it } from 'vitest'
import { readClip } from './clip'
import { readDrawing } from './drawing'
import { createSheetEditor } from './editor'
import { readNotes } from './notes'
import { requireRange } from './ref'
import { commentBook, pictureBook } from './test-utils/drawing-fixtures'
import { readThreads } from './threads'
import { openWorkbook } from './workbook'

const reopen = (bytes: Uint8Array) => openWorkbook(bytes)

describe('cut and paste: notes and threads move with the cells, pictures stay', () => {
  it('moves a note and a thread (with replies, mentions, ids) within the sheet and keeps them Excel-valid', () => {
    const ed = createSheetEditor(commentBook())
    const clip = readClip(ed, 'Notes', requireRange('B2:C4'), 'book')
    ed.apply({ op: 'paste', sheet: 'Notes', at: 'E10', clip, cut: true })
    const wb = reopen(ed.toBytes())
    const info = wb.requireWorksheet('Notes')
    expect(readNotes(wb, info).map((n) => [n.ref, n.author, n.visible])).toEqual([['E10', 'Ada Lovelace', true]])
    const [t] = readThreads(wb, info)
    expect(t).toMatchObject({ id: '{11111111-1111-1111-1111-111111111111}', ref: 'F12', resolved: false })
    expect(t!.comments.map((c) => c.author)).toEqual(['Ada Lovelace', 'Grace Hopper'])
    expect(t!.comments[1]!.mentions).toEqual([{ name: 'Ada Lovelace', memberId: 'u-ada', start: 0, length: 13 }])
    // The thread's legacy stand-in and both VML boxes followed.
    const comments = wb.pkg.text('/xl/comments1.xml')
    expect(comments).toContain('ref="F12"')
    expect(comments).not.toMatch(/ref="(B2|C4)"/)
    const vml = wb.pkg.text('/xl/drawings/vmlDrawing1.vml')
    expect(vml).toContain('<x:Row>9</x:Row><x:Column>4</x:Column>')
    expect(vml).toContain('<x:Row>11</x:Row><x:Column>5</x:Column>')
  })

  it('moves them to another sheet (its parts created), and the pasted cells replace the target’s note', () => {
    const ed = createSheetEditor(commentBook())
    ed.apply({ op: 'set_note', sheet: 'Plain', ref: 'B2', text: 'old note', author: 'Bob' })
    const clip = readClip(ed, 'Notes', requireRange('B2:C4'), 'book')
    ed.apply({ op: 'paste', sheet: 'Plain', at: 'B2', clip, cut: true })
    const wb = reopen(ed.toBytes())
    expect(readNotes(wb, wb.requireWorksheet('Notes'))).toEqual([])
    expect(readThreads(wb, wb.requireWorksheet('Notes'))).toEqual([])
    const plain = wb.requireWorksheet('Plain')
    expect(readNotes(wb, plain).map((n) => [n.ref, n.author])).toEqual([['B2', 'Ada Lovelace']])
    expect(readThreads(wb, plain).map((t) => [t.ref, t.comments.length])).toEqual([['C4', 2]])
    // The source sheet's emptied threaded part went with its relationship.
    expect(wb.pkg.relationships(wb.requireWorksheet('Notes').part).some((r) => r.type.endsWith('/threadedComment'))).toBe(false)
  })

  it('pictures, shapes and charts stay where they are; their parts are untouched', () => {
    const before = pictureBook()
    const ed = createSheetEditor(before)
    ed.apply({ op: 'set_cells', sheet: 'Pics', cells: [{ ref: 'B2', value: 1 }] })
    const drawingBefore = ed.wb.pkg.text('/xl/drawings/drawing1.xml')
    const clip = readClip(ed, 'Pics', requireRange('A1:D6'), 'book')
    ed.apply({ op: 'paste', sheet: 'Pics', at: 'A30', clip, cut: true })
    const wb = reopen(ed.toBytes())
    expect(wb.pkg.text('/xl/drawings/drawing1.xml')).toBe(drawingBefore)
    expect(readDrawing(wb, wb.requireWorksheet('Pics'))[0]!.anchor).toMatchObject({ from: { row: 1, col: 1 } })
  })

  it('a cut without notes or threads touches no comment part', () => {
    const ed = createSheetEditor(commentBook())
    const before = ed.wb.pkg.text('/xl/comments1.xml')
    const clip = readClip(ed, 'Notes', requireRange('A6:A6'), 'book')
    ed.apply({ op: 'paste', sheet: 'Notes', at: 'A8', clip, cut: true })
    expect(reopen(ed.toBytes()).pkg.text('/xl/comments1.xml')).toBe(before)
  })
})
