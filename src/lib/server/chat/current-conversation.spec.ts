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
      { id: 'm1', role: 'assistant', content: 'Welcome — let us build your website.', metadata: null },
      { id: 'm2', role: 'user', content: 'yes please', metadata: null },
      { id: 'm3', role: 'assistant', content: '', metadata: { variant: 'tool_preview', tool: 'site.create' } },
      { id: 'm4', role: 'assistant', content: 'Done.', metadata: null },
    ]
    const db = fakeDb([[{ id: 's-1' }], rows])
    expect(await loadCurrentConversation(db as never, 'u1')).toEqual({
      sessionId: 's-1',
      messages: rows,
    })
  })

  it('an edited turn shows as the edit: the superseded message and its reply stay in storage only', async () => {
    const rows = [
      { id: 'm1', role: 'user', content: 'old words', metadata: { supersededBy: 'm3' } },
      { id: 'm2', role: 'assistant', content: 'Stopped reply', metadata: { turnOf: 'm1', supersededBy: 'm3' } },
      { id: 'm3', role: 'user', content: 'new words', metadata: { replaces: 'm1' } },
      { id: 'm4', role: 'assistant', content: 'late reply to the old words', metadata: { turnOf: 'm1' } },
      { id: 'm5', role: 'assistant', content: 'the answer', metadata: { turnOf: 'm3' } },
    ]
    const db = fakeDb([[{ id: 's-1' }], rows])
    const { messages } = await loadCurrentConversation(db as never, 'u1')
    expect(messages.map((m) => m.id)).toEqual(['m3', 'm5'])
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
