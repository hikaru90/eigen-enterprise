import { describe, expect, it } from 'vitest'
import { createSheetEditor } from './editor'
import { commentBook, pictureBook, png } from './test-utils/drawing-fixtures'

const ada = { id: 'u-ada', name: 'Ada Lovelace' }

describe('a protected sheet: pictures, shapes, notes and comments are Excel’s “Edit objects”', () => {
  it('refuses them while objects are protected, and allows them when the protection lets objects be edited', () => {
    const ed = createSheetEditor(pictureBook())
    ed.apply({ op: 'protect_sheet', sheet: 'Pics' })
    expect(() => ed.apply({ op: 'insert_picture', sheet: 'Pics', image: png(10, 10), x: 0, y: 0 })).toThrow(/protected/)
    expect(() =>
      ed.apply({ op: 'insert_shape', sheet: 'Pics', geometry: 'rect', x: 0, y: 0, width: 10, height: 10 }),
    ).toThrow(/protected/)
    expect(() => ed.apply({ op: 'update_drawing', sheet: 'Pics', id: '2', alt: 'x' })).toThrow(/protected/)
    expect(() => ed.apply({ op: 'delete_drawing', sheet: 'Pics', id: '2' })).toThrow(/protected/)
    expect(() => ed.apply({ op: 'set_note', sheet: 'Pics', ref: 'A1', text: 'n', author: 'Ada' })).toThrow(/protected/)
    expect(() => ed.apply({ op: 'add_comment', sheet: 'Pics', ref: 'A2', text: 'c', author: ada })).toThrow(/protected/)

    ed.apply({ op: 'unprotect_sheet', sheet: 'Pics' })
    ed.apply({ op: 'protect_sheet', sheet: 'Pics', allow: { objects: true } })
    expect(ed.apply({ op: 'insert_picture', sheet: 'Pics', image: png(10, 10), x: 0, y: 0 }).created).toBeTruthy()
    ed.apply({ op: 'set_note', sheet: 'Pics', ref: 'A1', text: 'n', author: 'Ada' })
    expect(ed.apply({ op: 'add_comment', sheet: 'Pics', ref: 'A2', text: 'c', author: ada }).created).toBeTruthy()
  })

  it('covers replies, edits, resolving and deleting comments and notes', () => {
    const ed = createSheetEditor(commentBook())
    ed.apply({ op: 'protect_sheet', sheet: 'Notes' })
    const thread = '{11111111-1111-1111-1111-111111111111}'
    expect(() => ed.apply({ op: 'reply_comment', sheet: 'Notes', thread, text: 'r', author: ada })).toThrow(/protected/)
    expect(() => ed.apply({ op: 'edit_comment', sheet: 'Notes', id: thread, text: 'e', author: ada })).toThrow(/protected/)
    expect(() => ed.apply({ op: 'resolve_comment', sheet: 'Notes', thread, resolved: true })).toThrow(/protected/)
    expect(() => ed.apply({ op: 'delete_comment', sheet: 'Notes', id: thread, author: ada })).toThrow(/protected/)
    expect(() => ed.apply({ op: 'delete_note', sheet: 'Notes', ref: 'B2' })).toThrow(/protected/)
  })
})
