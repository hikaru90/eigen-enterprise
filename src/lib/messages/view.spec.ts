import { describe, expect, it } from 'vitest'
import { continuesRun, groupByDay, mergeMessages, setUnread, upsertConversation, type ConversationView, type MessageView } from './view'

const msg = (id: string, createdAt: string, authorId = 'a'): MessageView => ({
  id,
  conversationId: 'c',
  authorId,
  authorName: authorId,
  body: id,
  createdAt,
  editedAt: null,
  deleted: false,
})

describe('mergeMessages', () => {
  it('dedupes by id (live frame + own post) and keeps time order', () => {
    const a = msg('a', '2026-11-03T09:00:00.000Z')
    const b = msg('b', '2026-11-03T09:01:00.000Z')
    const merged = mergeMessages([b], [a, b, { ...b, body: 'edited' }])
    expect(merged.map((m) => m.id)).toEqual(['a', 'b'])
    expect(merged[1].body).toBe('edited')
  })
})

describe('groupByDay', () => {
  it('labels today and yesterday and starts a group per local day', () => {
    const now = new Date(2026, 10, 3, 12)
    const groups = groupByDay(
      [
        msg('1', new Date(2026, 10, 1, 10).toISOString()),
        msg('2', new Date(2026, 10, 2, 10).toISOString()),
        msg('3', new Date(2026, 10, 3, 9).toISOString()),
        msg('4', new Date(2026, 10, 3, 10).toISOString()),
      ],
      now,
    )
    expect(groups.map((g) => [g.label === 'Today' || g.label === 'Yesterday' ? g.label : 'date', g.messages.length])).toEqual([
      ['date', 1],
      ['Yesterday', 1],
      ['Today', 2],
    ])
  })
})

describe('continuesRun', () => {
  it('same author within five minutes', () => {
    const a = msg('a', '2026-11-03T09:00:00.000Z')
    expect(continuesRun(a, msg('b', '2026-11-03T09:04:00.000Z'))).toBe(true)
    expect(continuesRun(a, msg('b', '2026-11-03T09:06:00.000Z'))).toBe(false)
    expect(continuesRun(a, msg('b', '2026-11-03T09:01:00.000Z', 'other'))).toBe(false)
  })
})

describe('conversation list', () => {
  const c = (id: string, kind: 'channel' | 'dm', title: string): ConversationView => ({
    id,
    kind,
    title,
    topic: '',
    private: false,
    unread: 0,
    memberIds: [],
  })
  it('keeps channels sorted by name before DMs, newest DM first; upsert replaces', () => {
    let list = [c('1', 'channel', 'random'), c('d1', 'dm', 'Bea')]
    list = upsertConversation(list, c('2', 'channel', 'general'))
    list = upsertConversation(list, c('d2', 'dm', 'Carl'))
    expect(list.map((x) => x.id)).toEqual(['2', '1', 'd2', 'd1'])
    expect(setUnread(list, '1', 3).find((x) => x.id === '1')!.unread).toBe(3)
  })
})
