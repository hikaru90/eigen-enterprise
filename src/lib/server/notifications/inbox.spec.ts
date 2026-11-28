import { describe, expect, it } from 'vitest'
import { InboxError, loadInbox, markInboxRead, type InboxDeps, type InboxSourceItem } from './inbox'

function setup(items: InboxSourceItem[]) {
  const reads = new Map<string, Set<string>>()
  const deps: InboxDeps = {
    sources: async () => items,
    reads: {
      async readKeys(userId, keys) {
        const mine = reads.get(userId) ?? new Set()
        return new Set(keys.filter((k) => mine.has(k)))
      },
      async markRead(userId, keys) {
        const mine = reads.get(userId) ?? new Set<string>()
        keys.forEach((k) => mine.add(k))
        reads.set(userId, mine)
      },
    },
  }
  return deps
}

const item = (key: string, at: string): InboxSourceItem => ({ key, kind: 'question', title: key, detail: '', href: '/x', at })

describe('notification inbox', () => {
  it('lists every item newest first, all unread at first', async () => {
    const inbox = await loadInbox(setup([item('a', '2026-11-01T00:00:00Z'), item('b', '2026-11-02T00:00:00Z')]), 'u')
    expect(inbox.items.map((i) => i.key)).toEqual(['b', 'a'])
    expect(inbox.unread).toBe(2)
  })

  it('marking read keeps the item but drops it from the unread count, per person', async () => {
    const d = setup([item('a', '2026-11-01T00:00:00Z'), item('b', '2026-11-02T00:00:00Z')])
    const after = await markInboxRead(d, 'u', ['a'])
    expect(after.unread).toBe(1)
    expect(after.items.find((i) => i.key === 'a')?.unread).toBe(false)
    expect((await loadInbox(d, 'other')).unread).toBe(2)
  })

  it('refuses keys that are not in the person’s inbox, and an empty list', async () => {
    const d = setup([item('a', '2026-11-01T00:00:00Z')])
    await expect(markInboxRead(d, 'u', ['nope'])).rejects.toThrow(InboxError)
    await expect(markInboxRead(d, 'u', [])).rejects.toThrow(InboxError)
  })
})
