import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { readNotes } from './notes'
import { lossesOf } from './ops'
import { buildXlsx, num, row } from './test-utils/build-xlsx'
import { commentBook } from './test-utils/drawing-fixtures'
import { MEMBER_PROVIDER, readPersons, readThreads, type Member } from './threads'
import { openWorkbook } from './workbook'

const files = (bytes: Uint8Array) => unzipSync(bytes)
const text = (bytes: Uint8Array, name: string) => strFromU8(files(bytes)[name]!)
const threadsOf = (bytes: Uint8Array, sheet = 'Notes') => {
  const wb = openWorkbook(bytes)
  return readThreads(wb, wb.requireWorksheet(sheet))
}

const ada: Member = { id: 'u-ada', name: 'Ada Lovelace' }
const bob: Member = { id: 'u-bob', name: 'Bob Builder' }
const alice: Member = { id: 'u-alice', name: 'Alice' }
const al: Member = { id: 'u-al', name: 'Al' }

describe('threaded comments and persons', () => {
  it('reads threaded comments, replies, mentions and persons from an Excel 365 workbook', () => {
    const wb = openWorkbook(commentBook())
    const persons = readPersons(wb)
    expect(persons).toEqual([
      { id: '{AAAAAAAA-0000-0000-0000-000000000001}', name: 'Ada Lovelace', userId: 'u-ada', providerId: 'None' },
      { id: '{AAAAAAAA-0000-0000-0000-000000000002}', name: 'Grace Hopper', userId: 'grace@example.com', providerId: 'AD' },
    ])
    const threads = readThreads(wb, wb.requireWorksheet('Notes'))
    expect(threads).toEqual([
      {
        id: '{11111111-1111-1111-1111-111111111111}',
        ref: 'C4',
        row: 3,
        col: 2,
        resolved: false,
        comments: [
          {
            id: '{11111111-1111-1111-1111-111111111111}',
            author: 'Ada Lovelace',
            authorId: 'u-ada',
            at: '2026-11-20T09:30:00.00',
            text: 'Is this final?',
            mentions: [],
          },
          {
            id: '{22222222-2222-2222-2222-222222222222}',
            author: 'Grace Hopper',
            authorId: null,
            at: '2026-11-20T10:00:00.00',
            text: '@Ada Lovelace yes, signed off',
            mentions: [{ name: 'Ada Lovelace', memberId: 'u-ada', start: 0, length: 13 }],
          },
        ],
      },
    ])
  })

  it('keeps threaded comments, persons, comments and VML byte for byte on unrelated edits', () => {
    const before = commentBook()
    const ed = createSheetEditor(before)
    ed.apply({ op: 'set_cells', sheet: 'Notes', cells: [{ ref: 'A6', value: 123 }] })
    const after = ed.toBytes()
    for (const p of [
      'xl/threadedComments/threadedComment1.xml',
      'xl/persons/person.xml',
      'xl/comments1.xml',
      'xl/drawings/vmlDrawing1.vml',
    ]) {
      expect(files(after)[p], p).toEqual(files(before)[p])
    }
  })

  it('adds, replies, edits, resolves/reopens and deletes threads with persons & legacy stand-in sync + undo', () => {
    const ed = createSheetEditor(commentBook())
    const addRes = ed.apply({
      op: 'add_comment',
      sheet: 'Plain',
      ref: 'D2',
      text: 'Check @Bob Builder please',
      author: ada,
      mentions: [bob],
      now: '2026-11-25T10:00:00.000Z',
    })
    const threadId = addRes.created!
    expect(threadId).toMatch(/^\{[0-9A-F-]+\}$/)

    const replyRes = ed.apply({
      op: 'reply_comment',
      sheet: 'Plain',
      thread: threadId,
      text: 'Looks good',
      author: bob,
      mentions: [ada],
      now: '2026-11-25T10:05:00.000Z',
    })
    const replyId = replyRes.created!

    // Reply appended @Ada Lovelace since text omitted it
    let threads = threadsOf(ed.toBytes(), 'Plain')
    expect(threads[0]!.comments[1]).toMatchObject({
      author: 'Bob Builder',
      authorId: 'u-bob',
      text: 'Looks good @Ada Lovelace',
      mentions: [{ name: 'Ada Lovelace', memberId: 'u-ada', start: 11, length: 13 }],
    })

    // Persons list records Bob with providerId="None"
    const persons = readPersons(openWorkbook(ed.toBytes()))
    expect(persons.find((p) => p.userId === 'u-bob')).toMatchObject({
      name: 'Bob Builder',
      providerId: MEMBER_PROVIDER,
    })

    // Legacy stand-in stays synced and readNotes skips it
    let out = ed.toBytes()
    expect(readNotes(openWorkbook(out), openWorkbook(out).requireWorksheet('Plain'))).toEqual([])
    expect(text(out, 'xl/comments2.xml')).toContain('[Threaded comment]')
    expect(text(out, 'xl/comments2.xml')).toContain('Looks good @Ada Lovelace')

    // Edit reply as Bob, resolve, then reopen
    ed.apply({ op: 'edit_comment', sheet: 'Plain', id: replyId, text: 'Fixed now', author: bob })
    ed.apply({ op: 'resolve_comment', sheet: 'Plain', thread: threadId, resolved: true })
    threads = threadsOf(ed.toBytes(), 'Plain')
    expect(threads[0]!.resolved).toBe(true)
    expect(threads[0]!.comments[1]!.text).toBe('Fixed now')

    ed.apply({ op: 'resolve_comment', sheet: 'Plain', thread: threadId, resolved: false })
    expect(threadsOf(ed.toBytes(), 'Plain')[0]!.resolved).toBe(false)

    // Delete reply leaves root thread
    ed.apply({ op: 'delete_comment', sheet: 'Plain', id: replyId, author: bob })
    expect(threadsOf(ed.toBytes(), 'Plain')[0]!.comments).toHaveLength(1)

    // Delete root removes threadedComments part and stand-in parts cleanly, and undo brings them back
    ed.apply({ op: 'delete_comment', sheet: 'Plain', id: threadId, author: ada })
    out = ed.toBytes()
    expect(threadsOf(out, 'Plain')).toEqual([])
    expect(files(out)['xl/threadedComments/threadedComment2.xml']).toBeUndefined()
    expect(files(out)['xl/comments2.xml']).toBeUndefined()

    ed.undo()
    out = ed.toBytes()
    expect(threadsOf(out, 'Plain')).toHaveLength(1)
    expect(text(out, 'xl/comments2.xml')).toContain('Check @Bob Builder please')
  })

  it('respects word boundaries when matching @mentions so @Al does not collide with @Alice', () => {
    const bytes = buildXlsx({ sheets: [{ name: 'S', rows: row(1, num('A1', 1)) }] })
    const ed = createSheetEditor(bytes)
    ed.apply({
      op: 'add_comment',
      sheet: 'S',
      ref: 'A1',
      text: 'Hey @Alice',
      author: ada,
      mentions: [al, alice],
    })
    const c = threadsOf(ed.toBytes(), 'S')[0]!.comments[0]!
    expect(c.text).toBe('Hey @Alice @Al')
    expect(c.mentions).toEqual([
      { name: 'Al', memberId: 'u-al', start: 11, length: 3 },
      { name: 'Alice', memberId: 'u-alice', start: 4, length: 6 },
    ])
  })

  it('enforces author permissions, cell conflict rules, and text/ref validation', () => {
    const ed = createSheetEditor(commentBook())
    expect(() => ed.apply({ op: 'add_comment', sheet: 'Notes', ref: 'bad', text: 'hi', author: ada })).toThrow(/cell address/)
    expect(() => ed.apply({ op: 'add_comment', sheet: 'Notes', ref: 'D4', text: '  ', author: ada })).toThrow(/needs text/)
    expect(() =>
      ed.apply({ op: 'add_comment', sheet: 'Notes', ref: 'D4', text: 'x'.repeat(32_768), author: ada }),
    ).toThrow(/32767/)
    expect(() => ed.apply({ op: 'add_comment', sheet: 'Notes', ref: 'C4', text: 'dup', author: ada })).toThrow(
      /already has a comment thread/,
    )
    expect(() => ed.apply({ op: 'add_comment', sheet: 'Notes', ref: 'B2', text: 'note conflict', author: ada })).toThrow(
      /has a note/,
    )
    expect(() =>
      ed.apply({
        op: 'edit_comment',
        sheet: 'Notes',
        id: '{11111111-1111-1111-1111-111111111111}',
        text: 'hijack',
        author: bob,
      }),
    ).toThrow(/Only Ada Lovelace/)
    expect(() =>
      ed.apply({
        op: 'delete_comment',
        sheet: 'Notes',
        id: '{22222222-2222-2222-2222-222222222222}',
        author: bob,
      }),
    ).toThrow(/Only Grace Hopper/)
  })

  it('moves threads and stand-ins on row/col insert, delete and row sort without reporting a loss', () => {
    const ed = createSheetEditor(commentBook())
    const insOp = { op: 'insert_rows', sheet: 'Notes', at: 2, count: 2 } as const
    expect(lossesOf(ed.wb, insOp).map((l) => l.feature)).not.toContain('threaded_comments')
    ed.apply(insOp)
    expect(threadsOf(ed.toBytes())[0]).toMatchObject({ ref: 'C6', row: 5, col: 2 })
    expect(text(ed.toBytes(), 'xl/comments1.xml')).toContain('ref="C6"')

    ed.apply({ op: 'insert_columns', sheet: 'Notes', at: 1, count: 1 })
    expect(threadsOf(ed.toBytes())[0]).toMatchObject({ ref: 'D6', row: 5, col: 3 })

    // Deleting row 5 (0-based) drops the sole thread and cleans up threadedComment1.xml
    ed.apply({ op: 'delete_rows', sheet: 'Notes', at: 5, count: 1 })
    const afterDel = ed.toBytes()
    expect(threadsOf(afterDel)).toEqual([])
    expect(files(afterDel)['xl/threadedComments/threadedComment1.xml']).toBeUndefined()

    // Row sorting moves threads with their rows without reporting a threaded_comments loss
    const sortBytes = buildXlsx({
      sheets: [{ name: 'S', rows: row(1, num('A1', 50)) + row(2, num('A2', 10)) }],
    })
    const sortEd = createSheetEditor(sortBytes)
    sortEd.apply({ op: 'add_comment', sheet: 'S', ref: 'A1', text: 'Fifty', author: ada })
    sortEd.apply({ op: 'add_comment', sheet: 'S', ref: 'A2', text: 'Ten', author: bob })
    const sortOp = { op: 'sort_range', sheet: 'S', range: 'A1:A2', header: false, keys: [{ col: 0 }] } as const
    expect(lossesOf(sortEd.wb, sortOp).map((l) => l.feature)).not.toContain('threaded_comments')
    sortEd.apply(sortOp)
    const sorted = threadsOf(sortEd.toBytes(), 'S')
    expect(sorted.find((t) => t.comments[0]!.text === 'Fifty')).toMatchObject({ ref: 'A2', row: 1 })
    expect(sorted.find((t) => t.comments[0]!.text === 'Ten')).toMatchObject({ ref: 'A1', row: 0 })
  })
})
