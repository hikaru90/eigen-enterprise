import { describe, expect, it, vi } from 'vitest'
import { loadApprovalStatuses, loadCurrentConversation } from './current-conversation'

/** Minimal drizzle-shaped fake: each select() resolves the next queued result. */
function fakeDb(results: unknown[][]) {
  const queue = [...results]
  const db = {
    select: vi.fn(() => {
      const result = queue.shift() ?? []
      const chain: Record<string, unknown> = {}
      chain.from = () => chain
      chain.where = () => chain
      chain.orderBy = () => chain
      chain.limit = () => Promise.resolve(result)
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(result).then(res, rej)
      return chain
    }),
  }
  return db
}

describe('loadCurrentConversation', () => {
  it('returns no session and no messages for a user who never chatted', async () => {
    const db = fakeDb([[]])
    expect(await loadCurrentConversation(db as never, 'u1')).toEqual({
      sessionId: null,
      messages: [],
    })
    expect(db.select).toHaveBeenCalledTimes(1)
  })

  it("returns the user's latest default session with its messages in order", async () => {
    const rows = [
      { role: 'assistant', content: 'Welcome — let us build your website.', metadata: null },
      { role: 'user', content: 'yes please', metadata: null },
      { role: 'assistant', content: '', metadata: { variant: 'tool_preview', tool: 'site.create' } },
      { role: 'assistant', content: 'Done.', metadata: null },
    ]
    const db = fakeDb([[{ id: 's-1' }], rows])
    expect(await loadCurrentConversation(db as never, 'u1')).toEqual({
      sessionId: 's-1',
      messages: rows,
    })
  })

  it('looks up the current kernel status of the approval cards in the transcript', async () => {
    const db = fakeDb([[{ id: 'a1', status: 'pending' }, { id: 'a2', status: 'approved' }]])
    expect(await loadApprovalStatuses(db as never, ['a1', 'a2', 'a3'])).toEqual({
      a1: 'pending',
      a2: 'approved',
    })
    // No cards → no query.
    const empty = fakeDb([])
    expect(await loadApprovalStatuses(empty as never, [])).toEqual({})
    expect(empty.select).not.toHaveBeenCalled()
  })
})
