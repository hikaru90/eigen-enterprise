import { beforeEach, describe, expect, it } from 'vitest'
import { memoryReminderStore } from './memory-store'
import {
  completeReminder,
  createReminder,
  deleteReminder,
  listReminders,
  needsYouReminders,
  pauseReminder,
  REMINDER_LIMIT,
  ReminderError,
  resumeReminder,
  snoozeReminder,
  updateReminder,
  type ReminderDeps,
} from './service'

const ONY = 'user-ony'
const OTHER = 'user-other'

describe('reminders service', () => {
  let now: Date
  let n: number
  let deps: ReminderDeps & { store: ReturnType<typeof memoryReminderStore> }

  beforeEach(() => {
    // Saturday 2026-11-21 12:00 UTC.
    now = new Date('2026-11-21T12:00:00Z')
    n = 0
    deps = {
      store: memoryReminderStore(),
      timeZoneOf: async () => 'Europe/Berlin',
      now: () => now,
      newId: () => `rem-${++n}`,
    }
  })

  const linkedIn = (actorId = ONY) =>
    createReminder(deps, { userId: actorId, via: 'person' }, { title: 'LinkedIn posts', note: 'Prepare, check or send', weekdays: ['TH', 'MO'], time: '09:00' })

  it('creates a weekly reminder in the person’s time zone, first due at the next chosen weekday', async () => {
    const r = await linkedIn()
    expect(r).toMatchObject({
      id: 'rem-1',
      title: 'LinkedIn posts',
      note: 'Prepare, check or send',
      weekdays: ['MO', 'TH'],
      time: '09:00',
      timeZone: 'Europe/Berlin',
      status: 'active',
      createdVia: 'person',
      nextAt: '2026-11-23T08:00:00.000Z',
      due: null,
      snoozedUntil: null,
    })
  })

  it('takes an explicit time zone, and refuses a bad title, schedule or zone loud', async () => {
    const r = await createReminder(deps, { userId: ONY, via: 'assistant' }, { title: 'Standup notes', weekdays: ['FR'], time: '16:30', timeZone: 'America/New_York' })
    expect(r).toMatchObject({ timeZone: 'America/New_York', createdVia: 'assistant' })
    await expect(createReminder(deps, { userId: ONY, via: 'person' }, { title: '  ', weekdays: ['MO'], time: '09:00' })).rejects.toThrow(ReminderError)
    await expect(createReminder(deps, { userId: ONY, via: 'person' }, { title: 'x', weekdays: [], time: '09:00' })).rejects.toThrow(/weekday/)
    await expect(createReminder(deps, { userId: ONY, via: 'person' }, { title: 'x', weekdays: ['MO'], time: '9am' })).rejects.toThrow(/HH:MM/)
  })

  it('caps how many reminders one person keeps', async () => {
    for (let i = 0; i < REMINDER_LIMIT; i++) {
      await createReminder(deps, { userId: ONY, via: 'person' }, { title: `r${i}`, weekdays: ['MO'], time: '09:00' })
    }
    await expect(linkedIn()).rejects.toThrow(/at most/)
  })

  it('shows a due reminder under Needs you once its time came — one item with the oldest open occurrence and the count', async () => {
    await linkedIn()
    expect(await needsYouReminders(deps, ONY)).toEqual([])
    now = new Date('2026-11-23T08:00:00Z') // Monday 09:00 Berlin
    expect((await needsYouReminders(deps, ONY)).map((r) => r.due)).toEqual([
      { oldestAt: '2026-11-23T08:00:00.000Z', latestAt: '2026-11-23T08:00:00.000Z', count: 1 },
    ])
    now = new Date('2026-11-27T10:00:00Z') // missed Monday and Thursday: still one item
    const [item] = await needsYouReminders(deps, ONY)
    expect(item.due).toEqual({ oldestAt: '2026-11-23T08:00:00.000Z', latestAt: '2026-11-26T08:00:00.000Z', count: 2 })
  })

  it('is private: another person neither sees nor changes it', async () => {
    const r = await linkedIn()
    now = new Date('2026-11-23T08:00:00Z')
    expect(await listReminders(deps, OTHER)).toEqual([])
    expect(await needsYouReminders(deps, OTHER)).toEqual([])
    await expect(completeReminder(deps, OTHER, r.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(deleteReminder(deps, OTHER, r.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('ticks off the oldest open occurrence; the rest stay', async () => {
    const r = await linkedIn()
    now = new Date('2026-11-27T10:00:00Z')
    const after = await completeReminder(deps, ONY, r.id)
    expect(after.due).toEqual({ oldestAt: '2026-11-26T08:00:00.000Z', latestAt: '2026-11-26T08:00:00.000Z', count: 1 })
    const done = await completeReminder(deps, ONY, r.id)
    expect(done.due).toBeNull()
    expect(await needsYouReminders(deps, ONY)).toEqual([])
    await expect(completeReminder(deps, ONY, r.id)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('ticks off every open occurrence at once with all', async () => {
    const r = await linkedIn()
    now = new Date('2026-12-04T10:00:00Z') // four missed
    expect((await listReminders(deps, ONY))[0].due?.count).toBe(4)
    expect((await completeReminder(deps, ONY, r.id, { all: true })).due).toBeNull()
  })

  it('snoozes: hidden from Needs you until then, back afterwards (with what came due meanwhile)', async () => {
    const r = await linkedIn()
    now = new Date('2026-11-23T08:30:00Z')
    const snoozed = await snoozeReminder(deps, ONY, r.id, { minutes: 60 })
    expect(snoozed.snoozedUntil).toBe('2026-11-23T09:30:00.000Z')
    expect(await needsYouReminders(deps, ONY)).toEqual([])
    now = new Date('2026-11-23T09:30:00Z')
    expect(await needsYouReminders(deps, ONY)).toHaveLength(1)
    // Snoozed to a set instant; it must be in the future and within 30 days.
    await snoozeReminder(deps, ONY, r.id, { until: '2026-11-24T07:00:00Z' })
    expect(await needsYouReminders(deps, ONY)).toEqual([])
    await expect(snoozeReminder(deps, ONY, r.id, { until: '2026-11-20T07:00:00Z' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(snoozeReminder(deps, ONY, r.id, { minutes: 60 * 24 * 31 })).rejects.toMatchObject({ code: 'invalid' })
    await expect(snoozeReminder(deps, ONY, r.id, {})).rejects.toMatchObject({ code: 'invalid' })
  })

  it('ticking off clears a snooze', async () => {
    const r = await linkedIn()
    now = new Date('2026-11-27T10:00:00Z')
    await snoozeReminder(deps, ONY, r.id, { minutes: 120 })
    const after = await completeReminder(deps, ONY, r.id)
    expect(after.snoozedUntil).toBeNull()
    expect(await needsYouReminders(deps, ONY)).toHaveLength(1)
  })

  it('pauses (no occurrences, nothing under Needs you) and resumes from now — what fell in the pause is skipped', async () => {
    const r = await linkedIn()
    now = new Date('2026-11-23T08:30:00Z')
    const paused = await pauseReminder(deps, ONY, r.id)
    expect(paused).toMatchObject({ status: 'paused', nextAt: null, due: null })
    now = new Date('2026-12-01T10:00:00Z')
    expect(await needsYouReminders(deps, ONY)).toEqual([])
    await expect(pauseReminder(deps, ONY, r.id)).rejects.toMatchObject({ code: 'conflict' })
    await expect(snoozeReminder(deps, ONY, r.id, { minutes: 60 })).rejects.toMatchObject({ code: 'conflict' })
    const resumed = await resumeReminder(deps, ONY, r.id)
    expect(resumed).toMatchObject({ status: 'active', due: null, nextAt: '2026-12-03T08:00:00.000Z' })
    await expect(resumeReminder(deps, ONY, r.id)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('updates the text without touching what is due; a new rhythm starts from now', async () => {
    const r = await linkedIn()
    now = new Date('2026-11-23T08:30:00Z')
    const renamed = await updateReminder(deps, ONY, r.id, { title: 'LinkedIn', note: '' })
    expect(renamed).toMatchObject({ title: 'LinkedIn', note: '', due: { count: 1 } })
    const moved = await updateReminder(deps, ONY, r.id, { weekdays: ['TU'], time: '10:15' })
    expect(moved).toMatchObject({ weekdays: ['TU'], time: '10:15', due: null, nextAt: '2026-11-24T09:15:00.000Z' })
    await expect(updateReminder(deps, ONY, r.id, {})).rejects.toMatchObject({ code: 'invalid' })
  })

  it('deletes for good', async () => {
    const r = await linkedIn()
    expect(await deleteReminder(deps, ONY, r.id)).toEqual({ id: r.id, title: 'LinkedIn posts' })
    expect(await listReminders(deps, ONY)).toEqual([])
    await expect(deleteReminder(deps, ONY, r.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('orders Needs you by the oldest open occurrence', async () => {
    await createReminder(deps, { userId: ONY, via: 'person' }, { title: 'Thursday thing', weekdays: ['TH'], time: '09:00' })
    await createReminder(deps, { userId: ONY, via: 'person' }, { title: 'Monday thing', weekdays: ['MO'], time: '09:00' })
    now = new Date('2026-11-27T10:00:00Z')
    expect((await needsYouReminders(deps, ONY)).map((r) => r.title)).toEqual(['Monday thing', 'Thursday thing'])
  })
})
