import { describe, expect, it } from 'vitest'
import type { ReminderView } from '$lib/server/memory/reminders/service'
import { dueLine, nextLine, rhythmLine, WEEKDAY_LABELS } from './reminder-format'

const r = (over: Partial<ReminderView> = {}): ReminderView => ({
  id: 'r1',
  title: 'LinkedIn posts',
  note: '',
  weekdays: ['MO', 'TH'],
  time: '09:00',
  timeZone: 'Europe/Berlin',
  status: 'active',
  createdVia: 'person',
  createdAt: '2026-11-21T12:00:00.000Z',
  nextAt: '2026-11-23T08:00:00.000Z',
  due: null,
  snoozedUntil: null,
  ...over,
})

describe('reminder lines', () => {
  it('labels the weekdays Monday first', () => {
    expect(Object.values(WEEKDAY_LABELS)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  })

  it('reads the rhythm with its zone; every day reads as such', () => {
    expect(rhythmLine(r())).toBe('Mon, Thu · 09:00 · Europe/Berlin')
    expect(rhythmLine(r({ weekdays: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] }))).toBe('Every day · 09:00 · Europe/Berlin')
    expect(rhythmLine(r({ weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'] }))).toBe('Weekdays · 09:00 · Europe/Berlin')
  })

  it('says when it is next due — in the reminder’s zone — or that it is paused', () => {
    expect(nextLine(r())).toBe('Next Mon 23 Nov, 09:00')
    expect(nextLine(r({ status: 'paused', nextAt: null }))).toBe('Paused')
  })

  it('says since when it is due and how many are open; the snooze when one runs', () => {
    const due = { oldestAt: '2026-11-23T08:00:00.000Z', latestAt: '2026-11-26T08:00:00.000Z', count: 2 }
    expect(dueLine(r({ due }))).toBe('Due since Mon 23 Nov, 09:00 · 2 open')
    expect(dueLine(r({ due: { ...due, count: 1 } }))).toBe('Due since Mon 23 Nov, 09:00')
    expect(dueLine(r({ due, snoozedUntil: '2026-11-27T13:00:00.000Z' }))).toBe('Due since Mon 23 Nov, 09:00 · 2 open · snoozed until Fri 27 Nov, 14:00')
    expect(dueLine(r())).toBeNull()
  })
})
