import type { DueReminder } from './reminders'
import { describe, expect, it } from 'vitest'
import { reminderMinutes, reminderNotification, sendDueReminders, setReminderMinutes, dueReminders } from './reminders'
import { createEvent, deleteEvent, updateEvent } from './service'
import { agent, fixture, timed, user } from './test-fixtures'

/** Planning on Mon 16 Nov 2026, 10:00–11:00 Berlin = 09:00–10:00 UTC. */
const START = Date.parse('2026-11-16T09:00:00Z')
const at = (minutesBeforeStart: number) => new Date(START - minutesBeforeStart * 60_000)

describe('the reminder setting', () => {
  it('is 10 minutes until the person chooses; each person chooses their own, off included', async () => {
    const { deps, events } = fixture()
    expect(await reminderMinutes(deps, user('ana'))).toBe(10)
    expect(await setReminderMinutes(deps, user('ana'), 30)).toBe(30)
    expect(await reminderMinutes(deps, user('ana'))).toBe(30)
    expect(await reminderMinutes(deps, user('ben'))).toBe(10)
    expect(await setReminderMinutes(deps, user('ben'), null)).toBeNull()
    expect(await reminderMinutes(deps, user('ben'))).toBeNull()
    // The dialog's select posts text: "0" (when it starts) and "off".
    expect(await setReminderMinutes(deps, user('ana'), '0')).toBe(0)
    expect(await setReminderMinutes(deps, user('ana'), 'off')).toBeNull()
    expect(events.filter((e) => e.type === 'calendar.reminder_set').map((e) => e.payload)).toEqual([
      { minutes: 30 },
      { minutes: null },
      { minutes: 0 },
      { minutes: null },
    ])
  })

  it('takes only the offered choices, and the agent on its own has none', async () => {
    const { deps } = fixture()
    await expect(setReminderMinutes(deps, user('ana'), 7)).rejects.toMatchObject({ code: 'invalid' })
    await expect(setReminderMinutes(deps, user('ana'), '')).rejects.toMatchObject({ code: 'invalid' })
    await expect(setReminderMinutes(deps, agent, 10)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(reminderMinutes(deps, agent)).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('which reminders are due', () => {
  it('reminds the owner and the member guests who did not decline, each at their own lead', async () => {
    const { deps, store } = fixture()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00', { attendees: [{ memberId: 'ben' }, { memberId: 'olga' }] }))
    for (const g of store.guests.values()) if (g.memberId === 'olga') store.guests.set(g.id, { ...g, rsvp: 'declined' })
    await setReminderMinutes(deps, user('ben'), 30)

    expect(await dueReminders(deps, at(31))).toEqual([])
    expect((await dueReminders(deps, at(30))).map((r) => [r.memberId, r.minutes])).toEqual([['ben', 30]])
    const due = await dueReminders(deps, at(10))
    expect(due.map((r) => r.memberId)).toEqual(['ana'])
    expect(due[0]).toMatchObject({
      eventId: e.id,
      occurrenceStart: new Date(START),
      title: 'Planning',
      start: new Date(START),
      end: new Date(START + 3_600_000),
      minutes: 10,
      callId: null,
    })
  })

  it('a missed tick still reminds within five minutes; later, or once the event started, it stays quiet', async () => {
    const { deps } = fixture()
    await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00'))
    expect(await dueReminders(deps, at(6))).toHaveLength(1)
    await setReminderMinutes(deps, user('ana'), 15)
    expect(await dueReminders(deps, at(10))).toHaveLength(1)
    expect(await dueReminders(deps, at(9))).toHaveLength(0)
    await setReminderMinutes(deps, user('ana'), 0)
    expect(await dueReminders(deps, at(0))).toHaveLength(1)
    expect(await dueReminders(deps, at(-4))).toHaveLength(1)
    expect(await dueReminders(deps, at(-6))).toHaveLength(0)
  })

  it('no reminders for people who turned them off, for all-day events or for cancelled ones', async () => {
    const { deps } = fixture()
    await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00'))
    await createEvent(deps, user('ben'), { title: 'Holiday', allDay: true, start: '2026-11-16', end: '2026-11-16', timeZone: 'Europe/Berlin' })
    const off = await createEvent(deps, user('olga'), timed('2026-11-16', '10:00', '11:00'))
    await updateEvent(deps, user('olga'), off.id, { status: 'cancelled' })
    await setReminderMinutes(deps, user('ana'), null)
    expect(await dueReminders(deps, at(10))).toEqual([])
  })

  it('reminds each occurrence of a repeating event, at its own start', async () => {
    const { deps } = fixture()
    const s = await createEvent(deps, user('ana'), timed('2026-11-09', '10:00', '11:00', { rrule: 'FREQ=WEEKLY' }))
    const due = await dueReminders(deps, at(10))
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({ eventId: s.id, occurrenceStart: new Date(START) })
  })
})

describe('sending reminders', () => {
  it('pushes each due reminder once, whatever ticks again', async () => {
    const { deps } = fixture()
    await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00', { attendees: [{ memberId: 'ben' }] }))
    const pushed: string[] = []
    const push = async (memberId: string, r: DueReminder) => {
      pushed.push(`${memberId}:${r.title}`)
      return memberId === 'ben' ? ('no_device' as const) : ('sent' as const)
    }
    expect(await sendDueReminders(deps, push, at(10))).toEqual({ sent: 1, noDevice: 1, failed: 0 })
    expect(await sendDueReminders(deps, push, at(9))).toEqual({ sent: 0, noDevice: 0, failed: 0 })
    expect(pushed).toEqual(['ana:Planning', 'ben:Planning'])
  })

  it('a push that fails gives its claim back (the next tick tries again) and does not stop the others', async () => {
    const { deps } = fixture()
    await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00', { attendees: [{ memberId: 'ben' }] }))
    let fail = true
    const errors: unknown[] = []
    const push = async (memberId: string) => {
      if (memberId === 'ana' && fail) throw new Error('push service down')
      return 'sent' as const
    }
    expect(await sendDueReminders(deps, push, at(10), { onError: (e) => errors.push(e) })).toEqual({ sent: 1, noDevice: 0, failed: 1 })
    expect(String(errors[0])).toContain('push service down')
    fail = false
    expect(await sendDueReminders(deps, push, at(9))).toEqual({ sent: 1, noDevice: 0, failed: 0 })
  })

  it('a moved event is reminded at its new time; a deleted one never', async () => {
    const { deps } = fixture()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00'))
    const gone = await createEvent(deps, user('ben'), timed('2026-11-16', '10:00', '11:00'))
    await deleteEvent(deps, user('ben'), gone.id)
    const push = async () => 'sent' as const
    expect(await sendDueReminders(deps, push, at(10))).toEqual({ sent: 1, noDevice: 0, failed: 0 })
    await updateEvent(deps, user('ana'), e.id, { allDay: false, start: '2026-11-16T12:00', end: '2026-11-16T13:00', timeZone: 'Europe/Berlin' })
    expect(await sendDueReminders(deps, push, new Date(START + 2 * 3_600_000 - 10 * 60_000))).toEqual({ sent: 1, noDevice: 0, failed: 0 })
  })

  it('forgets old claims', async () => {
    const { deps, store } = fixture()
    await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00'))
    await sendDueReminders(deps, async () => 'sent' as const, at(10))
    expect(store.claimed.size).toBe(1)
    await sendDueReminders(deps, async () => 'sent' as const, new Date(START + 3 * 86_400_000))
    expect(store.claimed.size).toBe(0)
  })
})

describe('the notification', () => {
  const r: DueReminder = {
    memberId: 'ana',
    eventId: '00000000-0000-4000-8000-000000000001',
    occurrenceStart: new Date(START),
    title: 'Planning',
    start: new Date(START),
    end: new Date(START + 3_600_000),
    minutes: 10,
    callId: null,
  }

  it('says when, in the person’s own zone and language, and opens the day in the calendar', () => {
    expect(reminderNotification(r, { locale: 'en', timeZone: 'Europe/Berlin' })).toEqual({
      title: 'Planning',
      body: 'In 10 min · 10:00–11:00',
      url: '/m/calendar?view=day&date=2026-11-16',
      tag: `calendar-${r.eventId}-${START}`,
    })
    expect(reminderNotification({ ...r, minutes: 0 }, { locale: 'de', timeZone: 'America/New_York' }).body).toBe('Beginnt jetzt · 04:00–05:00')
    expect(reminderNotification(r, { locale: 'de', timeZone: 'Europe/Berlin' }).body).toBe('In 10 Min. · 10:00–11:00')
  })

  it('for an event with a call it opens the call: Join straight from the reminder', () => {
    const n = reminderNotification({ ...r, callId: 'call-1' }, { locale: 'en', timeZone: 'Europe/Berlin' })
    expect(n.url).toBe('/calls/call-1')
    expect(n.body).toBe('In 10 min · 10:00–11:00 · Tap to join the call')
    expect(reminderNotification({ ...r, callId: 'call-1' }, { locale: 'de', timeZone: 'Europe/Berlin' }).body).toBe(
      'In 10 Min. · 10:00–11:00 · Tippen, um dem Anruf beizutreten',
    )
  })
})
