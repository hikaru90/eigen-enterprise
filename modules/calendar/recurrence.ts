import { CalendarDate, CalendarDateTime, endOfMonth, fromAbsolute, toZoned } from '@internationalized/date'

/**
 * Recurring events (plan/calendar.md, owner decision 4): an RFC 5545 RRULE on
 * the series, expanded on read in the event's own time zone — a weekly 10:00
 * meeting stays at 10:00 wall time across daylight saving switches.
 *
 * The supported subset (what the event dialog writes, and what Google and
 * Outlook use for ordinary series): FREQ = DAILY | WEEKLY | MONTHLY | YEARLY,
 * INTERVAL, COUNT or UNTIL (a day or a UTC instant), BYDAY (weekdays for
 * WEEKLY; one nth weekday such as 2TU or -1FR for MONTHLY), BYMONTHDAY (one
 * day for MONTHLY, -1 = the last). Anything else is refused loud — never
 * expanded half-right. Pure (shared by server and browser).
 */

export class RecurrenceError extends Error {}

export const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const
export type Freq = (typeof FREQS)[number]

/** Monday first (ISO weeks). */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export type Until = { kind: 'day'; day: string } | { kind: 'instant'; at: Date }

export type Recurrence = {
  freq: Freq
  interval: number
  count?: number
  until?: Until
  /** WEEKLY: the days of the week (sorted Monday first). */
  byDay?: Weekday[]
  /** MONTHLY: one nth weekday (1..5 or -1..-5). */
  byNthDay?: { nth: number; day: Weekday }
  /** MONTHLY: one day of the month (1..31 or -1 = last). */
  byMonthDay?: number
}

export const RECURRENCE_LIMITS = { interval: 999, count: 1000 } as const

/** How many candidate days one expansion may walk (about 55 years of a daily series) before it fails loud. */
const MAX_STEPS = 20_000

const intIn = (text: string, part: string, min: number, max: number): number => {
  if (!/^-?\d+$/.test(text)) throw new RecurrenceError(`${part} must be a whole number, got ${JSON.stringify(text)}`)
  const n = Number(text)
  if (n < min || n > max) throw new RecurrenceError(`${part} must be between ${min} and ${max}, got ${n}`)
  return n
}

function parseUntil(text: string): Until {
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  if (day) {
    const value = `${day[1]}-${day[2]}-${day[3]}`
    if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new RecurrenceError(`UNTIL is not a real day: ${text}`)
    return { kind: 'day', day: value }
  }
  const instant = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text)
  if (instant) {
    const at = new Date(`${instant[1]}-${instant[2]}-${instant[3]}T${instant[4]}:${instant[5]}:${instant[6]}Z`)
    if (Number.isNaN(at.getTime())) throw new RecurrenceError(`UNTIL is not a real instant: ${text}`)
    return { kind: 'instant', at }
  }
  throw new RecurrenceError(`UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSSZ, got ${JSON.stringify(text)}`)
}

const isWeekday = (s: string): s is Weekday => (WEEKDAYS as readonly string[]).includes(s)

/** Parse an RRULE (with or without the `RRULE:` prefix); throws RecurrenceError naming the part it can't take. */
export function parseRrule(raw: string): Recurrence {
  const text = raw.trim().replace(/^RRULE:/i, '')
  const parts = new Map<string, string>()
  for (const piece of text.split(';').filter((p) => p !== '')) {
    const eq = piece.indexOf('=')
    if (eq <= 0) throw new RecurrenceError(`malformed RRULE part ${JSON.stringify(piece)}`)
    const key = piece.slice(0, eq).toUpperCase()
    if (parts.has(key)) throw new RecurrenceError(`${key} is given twice`)
    parts.set(key, piece.slice(eq + 1).toUpperCase())
  }
  const freq = parts.get('FREQ')
  if (!freq || !(FREQS as readonly string[]).includes(freq)) {
    throw new RecurrenceError(`FREQ must be one of ${FREQS.join(', ')}, got ${JSON.stringify(freq ?? null)}`)
  }
  const out: Recurrence = { freq: freq as Freq, interval: 1 }
  for (const [key, value] of parts) {
    switch (key) {
      case 'FREQ':
        break
      case 'INTERVAL':
        out.interval = intIn(value, 'INTERVAL', 1, RECURRENCE_LIMITS.interval)
        break
      case 'COUNT':
        out.count = intIn(value, 'COUNT', 1, RECURRENCE_LIMITS.count)
        break
      case 'UNTIL':
        out.until = parseUntil(value)
        break
      case 'WKST':
        if (value !== 'MO') throw new RecurrenceError(`WKST other than MO is not supported, got ${value}`)
        break
      case 'BYDAY': {
        const days = value.split(',')
        if (out.freq === 'WEEKLY') {
          if (!days.every(isWeekday)) throw new RecurrenceError(`BYDAY for a weekly rule takes plain weekdays (MO..SU), got ${value}`)
          out.byDay = WEEKDAYS.filter((d) => days.includes(d))
        } else if (out.freq === 'MONTHLY') {
          const m = days.length === 1 ? /^(-?[1-5])(MO|TU|WE|TH|FR|SA|SU)$/.exec(days[0]) : null
          if (!m) throw new RecurrenceError(`BYDAY for a monthly rule takes one nth weekday such as 2TU or -1FR, got ${value}`)
          out.byNthDay = { nth: Number(m[1]), day: m[2] as Weekday }
        } else {
          throw new RecurrenceError(`BYDAY is supported for weekly and monthly rules only`)
        }
        break
      }
      case 'BYMONTHDAY': {
        if (out.freq !== 'MONTHLY') throw new RecurrenceError('BYMONTHDAY is supported for monthly rules only')
        const n = intIn(value, 'BYMONTHDAY', -1, 31)
        if (n === 0) throw new RecurrenceError('BYMONTHDAY must be 1..31 or -1')
        out.byMonthDay = n
        break
      }
      default:
        throw new RecurrenceError(`${key} is not supported in a recurrence yet`)
    }
  }
  if (out.count !== undefined && out.until !== undefined) throw new RecurrenceError('a rule has COUNT and UNTIL — it takes one of them')
  if (out.byMonthDay !== undefined && out.byNthDay !== undefined) throw new RecurrenceError('BYMONTHDAY and BYDAY together are not supported')
  return out
}

const compact = (s: string) => s.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

/** The canonical RRULE text (no prefix): FREQ, INTERVAL, BYDAY/BYMONTHDAY, COUNT/UNTIL. */
export function formatRrule(r: Recurrence): string {
  const parts = [`FREQ=${r.freq}`]
  if (r.interval !== 1) parts.push(`INTERVAL=${r.interval}`)
  if (r.byDay) parts.push(`BYDAY=${r.byDay.join(',')}`)
  if (r.byNthDay) parts.push(`BYDAY=${r.byNthDay.nth}${r.byNthDay.day}`)
  if (r.byMonthDay !== undefined) parts.push(`BYMONTHDAY=${r.byMonthDay}`)
  if (r.count !== undefined) parts.push(`COUNT=${r.count}`)
  if (r.until) parts.push(`UNTIL=${r.until.kind === 'day' ? r.until.day.replace(/-/g, '') : compact(r.until.at.toISOString())}`)
  return parts.join(';')
}

// ── expansion ────────────────────────────────────────────────────────────────

/** When the first instance is, and how the series is anchored. */
export type SeriesTiming = { startsAt: Date; endsAt: Date; timeZone: string; allDay: boolean }

export type Instance = { start: Date; end: Date }

/** Monday = 0 … Sunday = 6. */
function weekdayIndex(d: CalendarDate): number {
  return (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7
}

const dayKey = (d: CalendarDate) => d.toString()

/** The nth (or nth-from-last) given weekday of a month, or null when the month has none. */
function nthWeekday(year: number, month: number, nth: number, day: Weekday): CalendarDate | null {
  const want = WEEKDAYS.indexOf(day)
  if (nth > 0) {
    const first = new CalendarDate(year, month, 1)
    const d = first.add({ days: ((want - weekdayIndex(first) + 7) % 7) + (nth - 1) * 7 })
    return d.month === month ? d : null
  }
  const last = endOfMonth(new CalendarDate(year, month, 1))
  const d = last.subtract({ days: ((weekdayIndex(last) - want + 7) % 7) + (-nth - 1) * 7 })
  return d.month === month ? d : null
}

function monthDay(year: number, month: number, day: number): CalendarDate | null {
  const last = endOfMonth(new CalendarDate(year, month, 1)).day
  if (day === -1) return new CalendarDate(year, month, last)
  return day <= last ? new CalendarDate(year, month, day) : null
}

/** Candidate days of the rule from the first day on, in order (the first day itself excluded). */
function* candidateDays(first: CalendarDate, r: Recurrence): Generator<CalendarDate> {
  const after = (d: CalendarDate) => d.compare(first) > 0
  switch (r.freq) {
    case 'DAILY':
      for (let k = 1; ; k++) yield first.add({ days: k * r.interval })
    case 'WEEKLY': {
      const days = (r.byDay ?? [WEEKDAYS[weekdayIndex(first)]]).map((d) => WEEKDAYS.indexOf(d))
      const monday = first.subtract({ days: weekdayIndex(first) })
      for (let w = 0; ; w++) {
        const weekStart = monday.add({ weeks: w * r.interval })
        for (const offset of days) {
          const d = weekStart.add({ days: offset })
          if (after(d)) yield d
        }
      }
    }
    case 'MONTHLY': {
      for (let k = 0; ; k++) {
        const m = new CalendarDate(first.year, first.month, 1).add({ months: k * r.interval })
        const d = r.byNthDay
          ? nthWeekday(m.year, m.month, r.byNthDay.nth, r.byNthDay.day)
          : monthDay(m.year, m.month, r.byMonthDay ?? first.day)
        if (d && after(d)) yield d
      }
    }
    case 'YEARLY': {
      for (let k = 1; ; k++) {
        const year = first.year + k * r.interval
        const d = monthDay(year, first.month, first.day)
        if (d) yield d
      }
    }
  }
}

type Anchor = {
  firstDay: CalendarDate
  /** Wall time of day of the first instance. */
  hour: number
  minute: number
  second: number
  durationMs: number
  durationDays: number
}

function anchorOf(s: SeriesTiming): Anchor {
  const start = fromAbsolute(s.startsAt.getTime(), s.timeZone)
  const end = fromAbsolute(s.endsAt.getTime(), s.timeZone)
  const firstDay = new CalendarDate(start.year, start.month, start.day)
  const durationDays = Math.round(
    (Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86_400_000,
  )
  return { firstDay, hour: start.hour, minute: start.minute, second: start.second, durationMs: s.endsAt.getTime() - s.startsAt.getTime(), durationDays }
}

function instanceOn(day: CalendarDate, a: Anchor, s: SeriesTiming): Instance {
  if (s.allDay) {
    const start = toZoned(new CalendarDateTime(day.year, day.month, day.day), s.timeZone, 'compatible').toDate()
    const last = day.add({ days: a.durationDays })
    const end = toZoned(new CalendarDateTime(last.year, last.month, last.day), s.timeZone, 'compatible').toDate()
    return { start, end }
  }
  const start = toZoned(new CalendarDateTime(day.year, day.month, day.day, a.hour, a.minute, a.second), s.timeZone, 'compatible').toDate()
  return { start, end: new Date(start.getTime() + a.durationMs) }
}

function untilAllows(u: Until | undefined, day: CalendarDate, inst: Instance): boolean {
  if (!u) return true
  return u.kind === 'day' ? dayKey(day) <= u.day : inst.start.getTime() <= u.at.getTime()
}

/** Every instance in order until the rule ends or `stop` says so (COUNT counts removed instances too, as RFC 5545 does). */
function* instances(s: SeriesTiming, r: Recurrence): Generator<Instance> {
  const a = anchorOf(s)
  const firstInstance = { start: s.startsAt, end: s.endsAt }
  if (!untilAllows(r.until, a.firstDay, firstInstance)) return
  yield firstInstance
  let produced = 1
  let steps = 0
  for (const day of candidateDays(a.firstDay, r)) {
    if (++steps > MAX_STEPS) throw new RecurrenceError(`a series walked more than ${MAX_STEPS} days without ending; look at a nearer range`)
    if (r.count !== undefined && produced >= r.count) return
    const inst = instanceOn(day, a, s)
    if (!untilAllows(r.until, day, inst)) return
    produced += 1
    yield inst
  }
}

/**
 * The instances of a series that overlap [from, to), in order, without the
 * removed ones (`exdates`, matched by instance start). Each instance's start
 * is also its id within the series (an override's `original_start`).
 */
export function expandSeries(
  s: SeriesTiming,
  r: Recurrence,
  window: { from: Date; to: Date },
  opts: { exdates?: readonly Date[] } = {},
): Instance[] {
  const removed = new Set((opts.exdates ?? []).map((d) => d.getTime()))
  const out: Instance[] = []
  for (const inst of instances(s, r)) {
    if (inst.start.getTime() >= window.to.getTime()) break
    if (inst.end.getTime() > window.from.getTime() && !removed.has(inst.start.getTime())) out.push(inst)
  }
  return out
}

/** Whether `start` is one of the series' instance starts (an override must replace a real one). */
export function isInstanceStart(s: SeriesTiming, r: Recurrence, start: Date): boolean {
  for (const inst of instances(s, r)) {
    if (inst.start.getTime() === start.getTime()) return true
    if (inst.start.getTime() > start.getTime()) return false
  }
  return false
}

/** The end of the series' last instance, or null when it never ends. */
export function seriesEnd(s: SeriesTiming, r: Recurrence): Date | null {
  if (r.count === undefined && r.until === undefined) return null
  let last: Instance | null = null
  for (const inst of instances(s, r)) last = inst
  return last ? last.end : s.endsAt
}
