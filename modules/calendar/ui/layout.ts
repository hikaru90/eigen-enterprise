import { addDays, dayStart, minutesOfDay, parseDay, weekdayOf } from '../time'

/**
 * Calendar layout (pure; the page and its components): which days a view
 * shows, how to step through them, and where an event sits on a day — all in
 * the viewer's own time zone.
 */

export const VIEWS = ['day', 'week', 'month'] as const
export type View = (typeof VIEWS)[number]

export const VIEW_LABELS: Record<View, string> = { day: 'Day', week: 'Week', month: 'Month' }

/** The `?view=` value: week when there is none; anything else is refused. */
export function parseView(value: string | null): View {
  if (value === null || value === '') return 'week'
  if ((VIEWS as readonly string[]).includes(value)) return value as View
  throw new Error(`view must be day, week or month, got ${JSON.stringify(value)}`)
}

const monday = (day: string) => addDays(day, -weekdayOf(day))
const firstOfMonth = (day: string) => `${day.slice(0, 7)}-01`

/** The days a view shows (a month: six whole Monday-to-Sunday weeks around it). */
export function viewDays(view: View, date: string): string[] {
  const first = view === 'day' ? date : view === 'week' ? monday(date) : monday(firstOfMonth(date))
  const count = view === 'day' ? 1 : view === 'week' ? 7 : 42
  return Array.from({ length: count }, (_, i) => addDays(first, i))
}

export function shiftDate(view: View, date: string, direction: -1 | 1): string {
  if (view === 'day') return addDays(date, direction)
  if (view === 'week') return addDays(date, 7 * direction)
  const d = parseDay(firstOfMonth(date))!
  return d.add({ months: direction }).toString()
}

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

const parts = (day: string) => ({ y: Number(day.slice(0, 4)), m: Number(day.slice(5, 7)), d: Number(day.slice(8, 10)) })
const dayMonth = (day: string) => `${parts(day).d} ${MONTH_NAMES[parts(day).m - 1]}`

/** "Wednesday, 18 November 2026" — the day's full name. */
export function longDay(day: string): string {
  return `${WEEKDAY_NAMES[weekdayOf(day)]}, ${dayMonth(day)} ${parts(day).y}`
}

/** What the view shows, in words. */
export function viewHeading(view: View, date: string): string {
  if (view === 'day') return longDay(date)
  if (view === 'month') return `${MONTH_NAMES[parts(date).m - 1]} ${parts(date).y}`
  const days = viewDays('week', date)
  const [a, b] = [parts(days[0]), parts(days[6])]
  if (a.y !== b.y) return `${dayMonth(days[0])} ${a.y} – ${dayMonth(days[6])} ${b.y}`
  if (a.m !== b.m) return `${dayMonth(days[0])} – ${dayMonth(days[6])} ${b.y}`
  return `${a.d} – ${dayMonth(days[6])} ${b.y}`
}

/** The UTC range a view covers in a zone (for the load). */
export function viewRange(view: View, date: string, timeZone: string): { from: Date; to: Date; days: string[] } {
  const days = viewDays(view, date)
  return { from: dayStart(parseDay(days[0])!, timeZone), to: dayStart(parseDay(addDays(days.at(-1)!, 1))!, timeZone), days }
}

type Timed = { start: string; end: string; allDay: boolean }

function bounds(day: string, tz: string): { start: number; end: number } {
  return { start: dayStart(parseDay(day)!, tz).getTime(), end: dayStart(parseDay(addDays(day, 1))!, tz).getTime() }
}

/** The items that touch a day: all-day ones (and timed ones filling the whole day) apart from timed ones. */
export function dayItems<T extends Timed>(items: readonly T[], day: string, tz: string): { allDay: T[]; timed: T[] } {
  const b = bounds(day, tz)
  const out = { allDay: [] as T[], timed: [] as T[] }
  for (const it of items) {
    const s = Date.parse(it.start)
    const e = Date.parse(it.end)
    if (!(s < b.end && e > b.start)) continue
    if (it.allDay || (s <= b.start && e >= b.end)) out.allDay.push(it)
    else out.timed.push(it)
  }
  return out
}

export type Placed<T> = {
  item: T
  /** Minutes from the day's local midnight. */
  top: number
  height: number
  /** Overlapping events share the width: this one's column of `columns`. */
  column: number
  columns: number
}

/** Timed items on a day, in minutes, clipped to the day, overlapping ones side by side. */
export function placeTimed<T extends Timed>(items: readonly T[], day: string, tz: string): Placed<T>[] {
  const b = bounds(day, tz)
  const dayMinutes = Math.round((b.end - b.start) / 60_000)
  const placed = items
    .map((item) => {
      const s = Math.max(Date.parse(item.start), b.start)
      const e = Math.min(Date.parse(item.end), b.end)
      const top = Date.parse(item.start) <= b.start ? 0 : minutesOfDay(new Date(s), tz)
      const bottom = e >= b.end ? dayMinutes : top + Math.round((e - s) / 60_000)
      return { item, top, height: Math.max(bottom - top, 0), column: 0, columns: 1 }
    })
    .sort((x, y) => x.top - y.top || y.height - x.height)
  // Clusters of transitively overlapping items share their column count.
  let cluster: typeof placed = []
  let clusterEnd = -1
  const close = () => {
    const cols = Math.max(1, ...cluster.map((p) => p.column + 1))
    for (const p of cluster) p.columns = cols
    cluster = []
  }
  for (const p of placed) {
    if (cluster.length > 0 && p.top >= clusterEnd) close()
    const taken = new Set(cluster.filter((q) => q.top + q.height > p.top).map((q) => q.column))
    let col = 0
    while (taken.has(col)) col++
    p.column = col
    cluster.push(p)
    clusterEnd = Math.max(clusterEnd, p.top + p.height)
  }
  if (cluster.length > 0) close()
  return placed
}
