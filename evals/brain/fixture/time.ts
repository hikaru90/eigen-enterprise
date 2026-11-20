import type { CompanyFixture } from '../types'

/**
 * Fixture time: the company "happened" relative to the run's anchor, in its
 * own time zone. Pure functions over Intl (no time library).
 */

function partsIn(at: Date, timeZone: string): { y: number; m: number; d: number; hh: number; mm: number } {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const n = (t: string) => Number(p.find((x) => x.type === t)?.value)
  return { y: n('year'), m: n('month'), d: n('day'), hh: n('hour'), mm: n('minute') }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD' of `at` in the zone, plus `days` calendar days. */
export function localDateOf(at: Date, timeZone: string, days: number): string {
  const { y, m, d } = partsIn(at, timeZone)
  const shifted = new Date(Date.UTC(y, m - 1, d + days))
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/** The date of the next `weekday` (0 = Sunday … 6 = Saturday) strictly after the anchor's local date. */
export function nextWeekdayDate(anchor: Date, timeZone: string, weekday: number): string {
  for (let i = 1; i <= 7; i += 1) {
    const date = localDateOf(anchor, timeZone, i)
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === weekday) return date
  }
  throw new Error(`unreachable: no weekday ${weekday} within 7 days`)
}

/** A local wall-clock time ('YYYY-MM-DD', 'HH:mm') in the zone as a UTC instant. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const [hh, mm] = time.split(':').map(Number) as [number, number]
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  // The zone's offset at that instant, applied twice to settle across a DST edge.
  let at = guess
  for (let i = 0; i < 2; i += 1) {
    const p = partsIn(new Date(at), timeZone)
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm)
    at = guess - (asUtc - at)
  }
  return new Date(at)
}

function longDate(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(`${date}T12:00:00Z`))
    .replace(',', '')
}

/** The rendered facts a suite's `{placeholder}` may name. */
export function factsFor(f: CompanyFixture, anchor: Date): Record<string, string> {
  const tz = f.company.timeZone
  const ev = (id: string) => {
    const e = f.events.find((x) => x.id === id)
    if (!e) throw new Error(`fixture has no event ${id}`)
    return `${longDate(localDateOf(anchor, tz, e.dayOffset))}, ${e.start}–${e.end}`
  }
  const call = f.calls.find((c) => c.id === 'call-acme')
  if (!call) throw new Error('fixture has no call-acme')
  return {
    today: longDate(localDateOf(anchor, tz, 0)),
    investorMeeting: ev('ev-investor'),
    designReview: ev('ev-design-review'),
    acmeCallDay: longDate(localDateOf(new Date(anchor.getTime() - call.minutesAgo * 60_000), tz, 0)),
  }
}

export function fillPlaceholders(text: string, facts: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = facts[name]
    if (value === undefined) throw new Error(`unknown placeholder {${name}}`)
    return value
  })
}
