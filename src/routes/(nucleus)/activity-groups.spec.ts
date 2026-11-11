import { describe, expect, it } from 'vitest'
import { groupActionsByDay } from './activity-groups'

describe('groupActionsByDay', () => {
  const now = new Date(2026, 10, 11, 15, 0)
  const at = (d: number, h: number) => new Date(2026, 10, d, h).toISOString()

  it('groups newest-first actions under Today, Yesterday and a dated header, keeping order', () => {
    const groups = groupActionsByDay(
      [
        { at: at(11, 14), text: 'a', ok: true },
        { at: at(11, 9), text: 'b', ok: false },
        { at: at(10, 20), text: 'c', ok: true },
        { at: at(3, 8), text: 'd', ok: true },
      ],
      now,
    )
    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(2026, 10, 3)),
    ])
    expect(groups.map((g) => g.actions.map((a) => a.text))).toEqual([['a', 'b'], ['c'], ['d']])
  })

  it('returns no groups for no actions', () => {
    expect(groupActionsByDay([], now)).toEqual([])
  })
})
