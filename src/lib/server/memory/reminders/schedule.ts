import { CalendarDate, CalendarDateTime, fromAbsolute, toZoned } from '@internationalized/date'

/**
 * A reminder's rhythm (Contribute 2c414719): fixed weekdays at one wall time
 * in the person's time zone — "Monday and Thursday, 09:00". The same
 * conventions as the calendar's recurrence (modules/calendar/recurrence.ts):
 * RFC 5545 weekday codes, Monday first, and the wall time kept across daylight
 * saving switches ('compatible': a time skipped by the spring switch moves
 * forward an hour, an ambiguous one takes the earlier instant). Not imported
 * from the calendar module: a module never reaches into another, and Memory
 * (always on) must not depend on Calendar (switchable). Pure.
 */

export class ReminderScheduleError extends Error {}

/** Monday first (ISO weeks), as the calendar writes BYDAY. */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export type WeeklySchedule = {
  /** The days of the week, Monday first, at least one. */
  weekdays: Weekday[]
  /** Wall time HH:MM (24 h). */
  time: string
  /** IANA time zone the wall time is in. */
  timeZone: string
}

export type DueOccurrences = { oldest: Date; latest: Date; count: number }

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The schedule, normalized (weekdays sorted Monday first, deduplicated); throws ReminderScheduleError naming what is wrong. */
export function validateSchedule(s: { weekdays: readonly string[]; time: string; timeZone: string }): WeeklySchedule {
  const unknown = s.weekdays.filter((d) => !(WEEKDAYS as readonly string[]).includes(d))
  if (unknown.length > 0) throw new ReminderScheduleError(`Unknown weekday ${JSON.stringify(unknown[0])}: use ${WEEKDAYS.join(', ')}.`)
  const weekdays = WEEKDAYS.filter((d) => s.weekdays.includes(d))
  if (weekdays.length === 0) throw new ReminderScheduleError('A reminder needs at least one weekday.')
  if (!TIME.test(s.time)) throw new ReminderScheduleError(`The time must be HH:MM on a 24-hour clock (got ${JSON.stringify(s.time)}).`)
  const timeZone = s.timeZone.trim()
  if (!timeZone || !validTimeZone(timeZone)) throw new ReminderScheduleError(`Unknown time zone ${JSON.stringify(s.timeZone)}.`)
  return { weekdays, time: s.time, timeZone }
}

/** Monday = 0 … Sunday = 6. */
function weekdayOf(d: CalendarDate): Weekday {
  return WEEKDAYS[(new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7]
}

function localDay(at: Date, tz: string): CalendarDate {
  const z = fromAbsolute(at.getTime(), tz)
  return new CalendarDate(z.year, z.month, z.day)
}

function occurrenceOn(day: CalendarDate, s: WeeklySchedule): Date {
  const [hour, minute] = s.time.split(':').map(Number)
  return toZoned(new CalendarDateTime(day.year, day.month, day.day, hour, minute), s.timeZone, 'compatible').toDate()
}

/** The first occurrence strictly after `after`. */
export function nextOccurrence(s: WeeklySchedule, after: Date): Date {
  const days = new Set(s.weekdays)
  // The local day before covers a time zone whose day starts earlier; eight more reach every weekday.
  let day = localDay(after, s.timeZone).subtract({ days: 1 })
  for (let i = 0; i < 9; i++, day = day.add({ days: 1 })) {
    if (!days.has(weekdayOf(day))) continue
    const at = occurrenceOn(day, s)
    if (at.getTime() > after.getTime()) return at
  }
  throw new ReminderScheduleError('A weekly reminder has no occurrence within a week — its weekdays are empty.')
}

/**
 * The occurrences after `handledThrough` (exclusive) up to `now` (inclusive):
 * the oldest open one, the latest, and how many. Null when none is due.
 */
export function dueOccurrences(s: WeeklySchedule, handledThrough: Date, now: Date): DueOccurrences | null {
  if (now.getTime() <= handledThrough.getTime()) return null
  const days = new Set(s.weekdays)
  const last = localDay(now, s.timeZone).add({ days: 1 })
  let oldest: Date | null = null
  let latest: Date | null = null
  let count = 0
  for (let day = localDay(handledThrough, s.timeZone).subtract({ days: 1 }); day.compare(last) <= 0; day = day.add({ days: 1 })) {
    if (!days.has(weekdayOf(day))) continue
    const at = occurrenceOn(day, s)
    if (at.getTime() <= handledThrough.getTime() || at.getTime() > now.getTime()) continue
    oldest ??= at
    latest = at
    count += 1
  }
  return oldest && latest ? { oldest, latest, count } : null
}
