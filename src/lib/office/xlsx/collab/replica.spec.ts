import type { SheetOp } from '../ops'
import { describe, expect, it } from 'vitest'
import { budgetBook } from '../test-utils/build-xlsx'
import { png } from '../test-utils/drawing-fixtures'
import { readThreads } from '../threads'
import { openWorkbook, type Workbook } from '../workbook'
import { pinChange, unpinned, type ChangeBody } from './protocol'
import { applyBody, restoreParts, seedOf } from './replica'

/**
 * Every replica applies the same entry to the same workbook and must end up
 * with the same bytes — also for operations that write random ids or salts
 * (threaded comments, conditional formats, passwords) or carry bytes (a
 * picture), once the change has travelled as JSON.
 */

const parts = (wb: Workbook) =>
  Object.fromEntries(wb.pkg.partNames().map((p) => [p, new TextDecoder().decode(wb.pkg.bytes(p))]))

/** The change as two replicas get it: pinned where it is made, then through JSON. */
function travelled(ops: SheetOp[]): ChangeBody {
  const pinned = pinChange({ kind: 'change', ops, acceptLosses: true }, () => new Date('2026-11-25T10:00:00Z'))
  return JSON.parse(JSON.stringify(pinned)) as ChangeBody
}

function both(ops: SheetOp[], seed = seedOf('tab-a', 'op-1')) {
  const body = travelled(ops)
  const a = openWorkbook(budgetBook())
  const b = openWorkbook(budgetBook())
  applyBody(a, body, seed)
  applyBody(b, body, seed)
  return { a, b, body }
}

describe('replicas write the same bytes', () => {
  it('a threaded comment: same ids and time in every replica', () => {
    const { a, b, body } = both([
      { op: 'add_comment', sheet: 'Budget', ref: 'C3', text: 'Check this', author: { id: 'alice', name: 'Alice' } },
    ])
    expect(body.ops[0]).toMatchObject({ now: '2026-11-25T10:00:00.000Z' })
    expect(parts(a)).toEqual(parts(b))
    const info = a.requireWorksheet('Budget')
    expect(readThreads(a, info)[0]).toMatchObject({ ref: 'C3' })
    // Another change's seed gives other ids.
    const c = openWorkbook(budgetBook())
    applyBody(c, body, seedOf('tab-a', 'op-2'))
    expect(parts(c)).not.toEqual(parts(a))
  })

  it('a password (its salt) and a conditional format (its GUID): the same in every replica', () => {
    const { a, b } = both([
      { op: 'cf_add', sheet: 'Budget', range: 'B2:B3', rule: { type: 'dataBar', bar: { color: '#638EC6' } } as never },
      { op: 'protect_sheet', sheet: 'Budget', password: 'secret' },
    ])
    expect(parts(a)).toEqual(parts(b))
  })

  it('a picture’s bytes survive the trip as JSON', () => {
    const image = png(20, 10)
    const { a, b, body } = both([{ op: 'insert_picture', sheet: 'Budget', image, x: 70, y: 2 }])
    expect(JSON.stringify(body)).toContain('$bytes')
    expect(parts(a)).toEqual(parts(b))
    const media = a.pkg.partNames().filter((p) => p.startsWith('/xl/media/'))
    expect(media).toHaveLength(1)
    expect([...a.pkg.bytes(media[0]!)]).toEqual([...image])
  })

  it('a comment that would read the clock is not loggable unpinned', () => {
    const raw: ChangeBody = {
      kind: 'change',
      acceptLosses: false,
      ops: [{ op: 'batch', ops: [{ op: 'reply_comment', sheet: 'S', thread: 't', text: 'x', author: { id: 'u', name: 'U' } }] }],
    }
    expect(unpinned(raw)).toMatch(/reply_comment needs its time/)
    expect(unpinned(pinChange(raw))).toBeNull()
  })
})

describe('undo of the new operations', () => {
  it('restoring a change’s parts takes back a merge, a note and a picture', () => {
    const wb = openWorkbook(budgetBook())
    const before = parts(wb)
    const ops: SheetOp[] = [
      { op: 'merge_cells', sheet: 'Budget', range: 'E2:F3', mode: 'merge' },
      { op: 'set_note', sheet: 'Budget', ref: 'A2', text: 'Rent', author: 'Alice' },
      { op: 'insert_picture', sheet: 'Budget', image: png(20, 10), x: 70, y: 2 },
    ]
    const { step } = applyBody(wb, travelled(ops), seedOf('t', 'o'))
    expect(parts(wb)).not.toEqual(before)
    restoreParts(wb, step.before)
    expect(parts(wb)).toEqual(before)
  })
})
