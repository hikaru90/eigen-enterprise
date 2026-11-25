import type { SheetOp } from '../ops'
import type { LogEntry, SubmitRequest, SubmitResponse } from './protocol'
import { describe, expect, it } from 'vitest'
import { cellKey } from '../ref'
import { budgetBook } from '../test-utils/build-xlsx'
import { createLiveSheet } from './client'

const book = budgetBook()
const remote = (seq: number, body: LogEntry['body']): LogEntry => ({
  seq,
  clientId: 'other-tab',
  opId: `r${seq}`,
  author: { kind: 'user', id: 'bob', name: 'Bob' },
  body,
  at: '2026-11-25T10:00:00Z',
})

describe('a grid’s live copy', () => {
  it('takes a change handed over as a reactive proxy (the page’s $state) and still rewrites it past others', () => {
    const sent: SubmitRequest[] = []
    const live = createLiveSheet({
      bytes: book,
      baseSeq: 0,
      entries: [],
      clientId: 'tab-a',
      newId: () => 'mine-1',
      transport: {
        submit: (req) => {
          sent.push(req)
          return new Promise<SubmitResponse>(() => {})
        },
        entriesAfter: async () => [],
      },
    })
    // A Proxy (as Svelte's $state hands objects over) can't be structured-cloned.
    const proxied = new Proxy({ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'B5', value: 7 }] } as SheetOp, {})
    live.apply(proxied)
    expect(sent[0]!.changes[0]!.body).toEqual({
      kind: 'change',
      ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'B5', value: 7 }] }],
      acceptLosses: false,
    })
    // Bob inserted a row above meanwhile: the pending write moves down with its row.
    live.receive([remote(1, { kind: 'change', ops: [{ op: 'insert_rows', sheet: 'Budget', at: 1, count: 1 }], acceptLosses: true })])
    expect(live.wb.sheet('Budget').cells.get(cellKey(5, 1))?.value).toBe(7)
    expect(live.wb.sheet('Budget').cells.get(cellKey(4, 1))?.value).not.toBe(7)
    expect(live.pending()).toBe(1)
    expect(live.seq()).toBe(1)
  })

  it('undo and redo of the new operations (a merge, a picture) are sent as reverts and restore the workbook', () => {
    const sent: SubmitRequest[] = []
    let n = 0
    const live = createLiveSheet({
      bytes: book,
      baseSeq: 0,
      entries: [],
      clientId: 'tab-a',
      newId: () => `mine-${++n}`,
      transport: {
        submit: (req) => {
          sent.push(req)
          return new Promise<SubmitResponse>(() => {})
        },
        entriesAfter: async () => [],
      },
    })
    live.apply({ op: 'merge_cells', sheet: 'Budget', range: 'E2:F3', mode: 'merge' })
    expect(live.wb.sheet('Budget').merges.length).toBeGreaterThan(1)
    live.undo()
    expect(live.wb.sheet('Budget').merges).toHaveLength(1)
    live.redo()
    expect(live.wb.sheet('Budget').merges.length).toBeGreaterThan(1)
    live.undo()
    expect(live.wb.sheet('Budget').merges).toHaveLength(1)
    expect(live.pending()).toBe(4)
    expect(sent[0]!.changes.map((c) => c.body.kind)).toEqual(['change'])
  })
})
