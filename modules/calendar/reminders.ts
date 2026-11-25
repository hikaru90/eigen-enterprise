import type { CalendarDeps } from './service'
import { m } from '$lib/paraglide/messages.js'
import { CalendarError } from './errors'
import { guestsByEvent, occurrences, personOf, seriesKey, viewerOf, type Actor } from './service'
import { localOf } from './time'
import { callJoinPath, DEFAULT_REMINDER_MINUTES, REMINDER_CHOICES, type ReminderMinutes } from './types'

/**
 * Reminders on the phone (plan/calendar.md K3, Contribute df14e05a): a push
 * before each timed event a person owns or is a member guest of (and did not
 * decline), as many minutes before as they chose (10 until they choose; or
 * none). For an event with a call the reminder opens the call — Join
 * straight from the notification.
 *
 * The job-queue tick (every minute) asks which reminders are due and sends
 * them; each is claimed in the store first, so none goes out twice — also
 * when a tick is late (up to CATCH_UP_MS) or two processes tick.
 */

/** A tick that comes late still reminds within this; later a reminder is noise. */
export const CATCH_UP_MS = 5 * 60_000
/** Claims are kept this long after the occurrence started, then forgotten. */
const KEEP_CLAIMS_MS = 2 * 86_400_000
const MAX_LEAD_MS = Math.max(...REMINDER_CHOICES) * 60_000

const invalid = (message: string) => new CalendarError('invalid', message)

/** The person's own lead in minutes; null = no reminders. */
export async function reminderMinutes(d: CalendarDeps, actor: Actor): Promise<ReminderMinutes | null> {
  const me = personOf(await viewerOf(d, actor))
  const stored = await d.store.reminderMinutes([me])
  return stored.has(me) ? (stored.get(me) as ReminderMinutes | null) : DEFAULT_REMINDER_MINUTES
}

/** `raw`: one of REMINDER_CHOICES (a number, or its text as a form posts it), or null / "off" for none. */
export function parseReminderMinutes(raw: unknown): ReminderMinutes | null {
  if (raw === null || raw === 'off') return null
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!(REMINDER_CHOICES as readonly number[]).includes(n)) {
    throw invalid(`A reminder is ${REMINDER_CHOICES.join(', ')} minutes before, or off; got ${JSON.stringify(raw ?? null)}`)
  }
  return n as ReminderMinutes
}

export async function setReminderMinutes(d: CalendarDeps, actor: Actor, raw: unknown): Promise<ReminderMinutes | null> {
  const minutes = parseReminderMinutes(raw)
  const v = await viewerOf(d, actor)
  await d.store.setReminderMinutes(personOf(v), minutes, d.now ? d.now() : new Date())
  await d.audit({ type: 'calendar.reminder_set', principalId: v.principalId, payload: { minutes } })
  return minutes
}

/** One reminder to send: an occurrence of an event, for one person. */
export type DueReminder = {
  memberId: string
  /** The stored event the occurrence comes from (a series, or a changed instance). */
  eventId: string
  occurrenceStart: Date
  title: string
  start: Date
  end: Date
  minutes: number
  callId: string | null
}

/** Everyone's reminders due at `at`: their lead has come (at most CATCH_UP_MS ago) and the event is ahead or just started. */
export async function dueReminders(d: CalendarDeps, at: Date): Promise<DueReminder[]> {
  const members = (await d.members()).map((x) => x.id)
  if (members.length === 0) return []
  const window = { from: new Date(at.getTime() - CATCH_UP_MS), to: new Date(at.getTime() + MAX_LEAD_MS + 1) }
  const rows = await d.store.inRange(members, window.from, window.to)
  if (rows.length === 0) return []
  const [guests, leads] = await Promise.all([guestsByEvent(d, rows), d.store.reminderMinutes(members)])
  const leadOf = (id: string) => (leads.has(id) ? leads.get(id)! : DEFAULT_REMINDER_MINUTES)
  const known = new Set(members)
  const out: DueReminder[] = []
  for (const o of occurrences(rows, window)) {
    if (o.row.status === 'cancelled' || o.row.allDay) continue
    const invited = (guests.get(seriesKey(o.row)) ?? []).filter((g) => g.memberId !== null && g.rsvp !== 'declined').map((g) => g.memberId!)
    for (const memberId of [o.row.ownerId, ...invited]) {
      if (!known.has(memberId)) continue
      const minutes = leadOf(memberId)
      if (minutes === null) continue
      const fireAt = o.start.getTime() - minutes * 60_000
      if (fireAt > at.getTime() || at.getTime() - fireAt > CATCH_UP_MS) continue
      out.push({ memberId, eventId: o.row.id, occurrenceStart: o.start, title: o.row.title, start: o.start, end: o.end, minutes, callId: o.row.callId })
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.memberId.localeCompare(b.memberId) || a.eventId.localeCompare(b.eventId))
}

/** Delivers one reminder to the person's devices: 'no_device' when they have none with notifications on. */
export type ReminderPush = (memberId: string, reminder: DueReminder) => Promise<'sent' | 'no_device'>

export type SendRemindersResult = { sent: number; noDevice: number; failed: number }

/**
 * Sends every due reminder once. A failed push gives its claim back (the
 * next tick tries again, within CATCH_UP_MS) and never stops the others;
 * `onError` hears each failure (the tick logs it loudly).
 */
export async function sendDueReminders(
  d: CalendarDeps,
  push: ReminderPush,
  at: Date,
  opts: { onError?: (err: unknown, reminder: DueReminder) => void } = {},
): Promise<SendRemindersResult> {
  const result: SendRemindersResult = { sent: 0, noDevice: 0, failed: 0 }
  await d.store.pruneReminders(new Date(at.getTime() - KEEP_CLAIMS_MS))
  for (const r of await dueReminders(d, at)) {
    const key = { eventId: r.eventId, occurrenceStart: r.occurrenceStart, memberId: r.memberId }
    if (!(await d.store.claimReminder(key, at))) continue
    try {
      if ((await push(r.memberId, r)) === 'sent') result.sent += 1
      else result.noDevice += 1
    } catch (err) {
      await d.store.releaseReminder(key)
      result.failed += 1
      opts.onError?.(err, r)
    }
  }
  return result
}

export type ReminderNotification = { title: string; body: string; url: string; tag: string }

/** The push as the person reads it: their language, times in their zone; a call event opens the call. */
export function reminderNotification(r: DueReminder, to: { locale: 'en' | 'de'; timeZone: string }): ReminderNotification {
  const from = localOf(r.start, to.timeZone)
  const time = `${from.time}–${localOf(r.end, to.timeZone).time}`
  const locale = { locale: to.locale }
  const when = r.minutes === 0 ? m.calendar_reminder_body_now({ time }, locale) : m.calendar_reminder_body({ minutes: r.minutes, time }, locale)
  return {
    title: r.title,
    body: r.callId === null ? when : `${when} · ${m.calendar_reminder_join({}, locale)}`,
    url: r.callId === null ? `/m/calendar?view=day&date=${from.day}` : callJoinPath(r.callId),
    tag: `calendar-${r.eventId}-${r.occurrenceStart.getTime()}`,
  }
}
