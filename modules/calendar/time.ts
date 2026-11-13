import { CalendarDate, CalendarDateTime, fromAbsolute, toZoned } from '@internationalized/date'

/**
 * Wall time ↔ instant in an IANA time zone (pure; server and browser). Events
 * are made in local wall time ("Tuesday 10:00, Berlin") and stored as UTC
 * instants plus the zone. A wall time that does not exist (the hour skipped
 * when clocks go forward) moves forward, one that exists twice takes the
 * first — the "compatible" rule Temporal and Google use.
 */

export const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
export const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '' || tz !== tz.trim()) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** A real `YYYY-MM-DD` day as a CalendarDate, or null. */
export function parseDay(text: unknown): CalendarDate | null {
  const m = typeof text === 'string' ? DAY.exec(text) : null
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new CalendarDate(y, mo, d)
  return date.year === y && date.month === mo && date.day === d ? date : null
}

/** A real `YYYY-MM-DDTHH:mm` wall time, or null. */
export function parseWall(text: unknown): CalendarDateTime | null {
  const m = typeof text === 'string' ? WALL.exec(text) : null
  if (!m) return null
  const day = parseDay(`${m[1]}-${m[2]}-${m[3]}`)
  const [h, mi] = [Number(m[4]), Number(m[5])]
  if (!day || h > 23 || mi > 59) return null
  return new CalendarDateTime(day.year, day.month, day.day, h, mi)
}

export function wallToInstant(wall: CalendarDateTime, tz: string): Date {
  return toZoned(wall, tz, 'compatible').toDate()
}

/** Midnight at the start of a day in a zone. */
export function dayStart(day: CalendarDate, tz: string): Date {
  return wallToInstant(new CalendarDateTime(day.year, day.month, day.day), tz)
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** An instant as local `{ day: YYYY-MM-DD, time: HH:mm }` in a zone. */
export function localOf(at: Date | string, tz: string): { day: string; time: string } {
  const z = fromAbsolute(new Date(at).getTime(), tz)
  return { day: `${pad(z.year, 4)}-${pad(z.month)}-${pad(z.day)}`, time: `${pad(z.hour)}:${pad(z.minute)}` }
}

/** Minutes since local midnight of an instant in a zone. */
export function minutesOfDay(at: Date | string, tz: string): number {
  const z = fromAbsolute(new Date(at).getTime(), tz)
  return z.hour * 60 + z.minute
}

export function addDays(day: string, n: number): string {
  const d = parseDay(day)
  if (!d) throw new Error(`not a day: ${day}`)
  return d.add({ days: n }).toString()
}

/** Monday = 0 … Sunday = 6. */
export function weekdayOf(day: string): number {
  const d = parseDay(day)
  if (!d) throw new Error(`not a day: ${day}`)
  return (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7
}

/** The local start/end an event's dialog shows: wall times, or days (end inclusive) for an all-day event. */
export function localSpan(start: Date | string, end: Date | string, tz: string, allDay: boolean): { start: string; end: string } {
  const s = localOf(start, tz)
  if (allDay) {
    const e = localOf(end, tz)
    return { start: s.day, end: addDays(e.day, -1) < s.day ? s.day : addDays(e.day, -1) }
  }
  const e = localOf(end, tz)
  return { start: `${s.day}T${s.time}`, end: `${e.day}T${e.time}` }
}
