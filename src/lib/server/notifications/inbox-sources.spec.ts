import { describe, expect, it } from 'vitest'
import { inboxItemsFrom } from './inbox-sources'

const person = (id: string, name: string) => ({ id, name })

describe('inbox sources', () => {
  it('maps questions for me, tasks given to me, news on tasks I gave and co-worker results into items with stable keys', () => {
    const items = inboxItemsFrom({
      questions: [{ id: 'q1', text: 'Van key?', author: person('ony', 'Ony'), createdAt: '2026-11-27T10:00:00.000Z' }],
      tasks: {
        assignedToMe: [
          { id: 't1', title: 'Ship it', assigner: person('kim', 'Kim'), assignee: person('me', 'Me'), createdAt: '2026-11-26T10:00:00.000Z', update: { kind: 'assigned', at: '2026-11-26T10:00:00.000Z' } },
        ],
        updates: [
          { id: 't2', title: 'Invoice', assigner: person('me', 'Me'), assignee: person('sam', 'Sam'), createdAt: '2026-11-20T10:00:00.000Z', update: { kind: 'completed', at: '2026-11-27T11:00:00.000Z' } },
        ],
      },
      notices: [{ run: { id: 'r1', status: 'done' }, coworker: person('cw', 'Scout'), at: '2026-11-27T12:00:00.000Z', href: '/messages?c=1' }],
    })
    expect(items).toEqual([
      { key: 'question:q1', kind: 'question', title: 'Ony asks', detail: 'Van key?', href: '/m/memory/questions', at: '2026-11-27T10:00:00.000Z' },
      { key: 'task:t1:2026-11-26T10:00:00.000Z', kind: 'task', title: 'Kim gave you a task', detail: 'Ship it', href: '/m/memory/tasks#assigned', at: '2026-11-26T10:00:00.000Z' },
      { key: 'task:t2:2026-11-27T11:00:00.000Z', kind: 'task_update', title: 'Sam completed your task', detail: 'Invoice', href: '/m/memory/tasks#assigned', at: '2026-11-27T11:00:00.000Z' },
      { key: 'coworker:r1', kind: 'coworker', title: 'Scout finished', detail: 'A result is waiting on you', href: '/messages?c=1', at: '2026-11-27T12:00:00.000Z' },
    ])
  })

  it('an open task without news keeps its creation as its moment; a comment reads as a comment', () => {
    const items = inboxItemsFrom({
      questions: [],
      tasks: {
        assignedToMe: [{ id: 't1', title: 'A', assigner: person('kim', 'Kim'), assignee: person('me', 'Me'), createdAt: '2026-11-26T10:00:00.000Z', update: null }],
        updates: [{ id: 't2', title: 'B', assigner: person('me', 'Me'), assignee: person('sam', 'Sam'), createdAt: '2026-11-20T10:00:00.000Z', update: { kind: 'commented', at: '2026-11-27T11:00:00.000Z' } }],
      },
      notices: [{ run: { id: 'r1', status: 'stopped' }, coworker: person('cw', 'Scout'), at: '2026-11-27T12:00:00.000Z', href: '/x' }],
    })
    expect(items.map((i) => [i.key, i.title])).toEqual([
      ['task:t1:2026-11-26T10:00:00.000Z', 'Kim gave you a task'],
      ['task:t2:2026-11-27T11:00:00.000Z', 'Sam commented on your task'],
      ['coworker:r1', 'Scout stopped'],
    ])
  })
})
