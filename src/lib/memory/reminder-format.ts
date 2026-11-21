import type { ReminderView } from '$lib/server/memory/reminders/service'

/**
 * How a reminder reads in Memory › Reminders and under the dashboard's Needs
 * you: its rhythm, when it is next, and what is due. Instants show in the
 * reminder's own time zone — the zone its time of day is in.
 */

export const WEEKDAY_LABELS = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' } as const

const formats = new Map<string, Intl.DateTimeFormat>()
function at(iso: string, timeZone: string): string {
  let f = formats.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone })
    formats.set(timeZone, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`
}

/** "Mon, Thu · 09:00 · Europe/Berlin". */
export function rhythmLine(r: Pick<ReminderView, 'weekdays' | 'time' | 'timeZone'>): string {
  const days =
    r.weekdays.length === 7
      ? 'Every day'
      : r.weekdays.join() === 'MO,TU,WE,TH,FR'
        ? 'Weekdays'
        : r.weekdays.map((d) => WEEKDAY_LABELS[d]).join(', ')
  return `${days} · ${r.time} · ${r.timeZone}`
}

/** "Next Mon 23 Nov, 09:00", or "Paused". */
export function nextLine(r: Pick<ReminderView, 'status' | 'nextAt' | 'timeZone'>): string {
  return r.status === 'paused' || !r.nextAt ? 'Paused' : `Next ${at(r.nextAt, r.timeZone)}`
}

/** "Due since Mon 23 Nov, 09:00 · 2 open"; null when nothing is due. */
export function dueLine(r: Pick<ReminderView, 'due' | 'snoozedUntil' | 'timeZone'>): string | null {
  if (!r.due) return null
  return [
    `Due since ${at(r.due.oldestAt, r.timeZone)}`,
    r.due.count > 1 ? `${r.due.count} open` : null,
    r.snoozedUntil ? `snoozed until ${at(r.snoozedUntil, r.timeZone)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
