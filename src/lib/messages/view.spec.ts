import { describe, expect, it } from 'vitest'
import {
  applyFrame,
  continuesRun,
  formatSize,
  groupByDay,
  mergeMessages,
  reactionTitle,
  setUnread,
  upsertConversation,
  type ConversationView,
  type MessageView,
} from './view'

const msg = (id: string, createdAt: string, authorId = 'a'): MessageView => ({
  id,
  conversationId: 'c',
  authorId,
  authorName: authorId,
  body: id,
  createdAt,
  editedAt: null,
  deleted: false,
  parentId: null,
  replyCount: 0,
  lastReplyAt: null,
  reactions: [],
  attachments: [],
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

describe('applyFrame (C2)', () => {
  const p = msg('p', '2026-11-03T09:00:00.000Z')
  const reply = { ...msg('r', '2026-11-03T09:05:00.000Z', 'b'), parentId: 'p' }
  it('a reply goes to its open thread and refreshes the parent in the log, never into the log itself', () => {
    const out = applyFrame([p], { parentId: 'p', replies: [] }, {
      action: 'created',
      message: reply,
      parent: { ...p, replyCount: 1, lastReplyAt: reply.createdAt },
      unread: 0,
    })
    expect(out.log.map((m) => [m.id, m.replyCount])).toEqual([['p', 1]])
    expect(out.replies?.map((m) => m.id)).toEqual(['r'])
  })
  it('a reply to another thread leaves the open thread alone', () => {
    const out = applyFrame([p], { parentId: 'other', replies: [] }, { action: 'created', message: reply, parent: p, unread: 0 })
    expect(out.replies).toEqual([])
  })
  it('a reaction/edit on a message not loaded (older page) is not pulled into the log', () => {
    const old = msg('old', '2026-11-01T09:00:00.000Z')
    expect(applyFrame([p], null, { action: 'reacted', message: old, parent: null, unread: 0 }).log.map((m) => m.id)).toEqual(['p'])
    expect(applyFrame([p], null, { action: 'created', message: old, parent: null, unread: 0 }).log.map((m) => m.id)).toEqual(['old', 'p'])
  })
})

describe('reactionTitle / formatSize', () => {
  it('names who reacted', () => {
    expect(reactionTitle({ emoji: '👍', userIds: ['a'], names: ['Bea'] })).toBe('Bea')
    expect(reactionTitle({ emoji: '👍', userIds: ['a', 'b'], names: ['Bea', 'Carl'] })).toBe('Bea and Carl')
    expect(reactionTitle({ emoji: '👍', userIds: [], names: ['A', 'B', 'C', 'D', 'E'] })).toBe('A, B, C and 2 others')
  })
  it('formats sizes', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1.5 KB')
  })
})
