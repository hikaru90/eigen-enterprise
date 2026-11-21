import type { Reminder, ReminderPatch, ReminderStore } from './store'
import { dueOccurrences, nextOccurrence, ReminderScheduleError, validateSchedule, type Weekday, type WeeklySchedule } from './schedule'

/**
 * Reminders (Contribute 2c414719, from Ony): a person's own recurring
 * reminders — fixed weekdays at a wall time in their time zone ("Monday and
 * Thursday, 09:00: prepare, check or send LinkedIn posts"). Private to the
 * person (row-level security, migration 0163). Nothing is sent: an occurrence
 * becomes due at its time and waits under the person's Needs you on the
 * dashboard the next time they are online, until they tick it off or snooze
 * it. Missed occurrences stay; they never stack — Needs you shows one item per
 * reminder with the oldest open occurrence and how many are open.
 *
 * The state is one mark per reminder, `handledThrough`: every occurrence at or
 * before it is handled. Ticking off moves it to the oldest open occurrence (or
 * the latest, with `all`). Pausing stops occurrences; resuming starts from
 * now, so what fell in the pause is skipped, not owed. A changed rhythm
 * (weekdays, time, zone) likewise starts from now; a changed title or note
 * leaves what is due alone. Computed on read: no job runs for it.
 */

export type ReminderDeps = {
  store: ReminderStore
  /** The person's time zone (Settings), for a reminder created without one. */
  timeZoneOf: (userId: string) => Promise<string>
  now?: () => Date
  newId?: () => string
}

/** Who acts: the person themself, or their assistant on their word in chat. */
export type ReminderActor = { userId: string; via: 'person' | 'assistant' }

export type ReminderView = {
  id: string
  title: string
  note: string
  weekdays: Weekday[]
  time: string
  timeZone: string
  status: 'active' | 'paused'
  createdVia: 'person' | 'assistant'
  createdAt: string
  /** The next occurrence still to come; null while paused. */
  nextAt: string | null
  /** The open occurrences (active reminders only); null = nothing due. */
  due: { oldestAt: string; latestAt: string; count: number } | null
  /** While a snooze runs, when it ends; null otherwise. */
  snoozedUntil: string | null
}

export class ReminderError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message)
    this.name = 'ReminderError'
  }
}

export const REMINDERS_URL = '/m/memory/reminders'
export const REMINDER_LIMIT = 100
const TITLE_MAX = 200
const NOTE_MAX = 2000
const SNOOZE_MAX_MS = 30 * 24 * 60 * 60 * 1000

const nowOf = (d: ReminderDeps) => (d.now ? d.now() : new Date())
const newIdOf = (d: ReminderDeps) => (d.newId ? d.newId() : crypto.randomUUID())

function title(raw: string): string {
  const t = raw.trim()
  if (!t || t.length > TITLE_MAX) throw new ReminderError('invalid', `A reminder needs a title of 1 to ${TITLE_MAX} characters.`)
  return t
}

function note(raw: string | undefined): string {
  const t = (raw ?? '').trim()
  if (t.length > NOTE_MAX) throw new ReminderError('invalid', `The note is longer than ${NOTE_MAX} characters.`)
  return t
}

function schedule(s: { weekdays: readonly string[]; time: string; timeZone: string }): WeeklySchedule {
  try {
    return validateSchedule(s)
  } catch (err) {
    if (err instanceof ReminderScheduleError) throw new ReminderError('invalid', err.message)
    throw err
  }
}

const scheduleOf = (r: Reminder): WeeklySchedule => ({ weekdays: r.weekdays, time: r.time, timeZone: r.timeZone })

function view(r: Reminder, now: Date): ReminderView {
  const active = r.status === 'active'
  const due = active ? dueOccurrences(scheduleOf(r), r.handledThrough, now) : null
  return {
    id: r.id,
    title: r.title,
    note: r.note,
    weekdays: [...r.weekdays],
    time: r.time,
    timeZone: r.timeZone,
    status: r.status,
    createdVia: r.createdVia,
    createdAt: r.createdAt.toISOString(),
    nextAt: active ? nextOccurrence(scheduleOf(r), now).toISOString() : null,
    due: due ? { oldestAt: due.oldest.toISOString(), latestAt: due.latest.toISOString(), count: due.count } : null,
    snoozedUntil: r.snoozedUntil && r.snoozedUntil.getTime() > now.getTime() ? r.snoozedUntil.toISOString() : null,
  }
}

async function own(d: ReminderDeps, userId: string, id: string): Promise<Reminder> {
  const r = await d.store.get(userId, id)
  if (!r) throw new ReminderError('not_found', 'Reminder not found.')
  return r
}

async function patch(d: ReminderDeps, userId: string, id: string, p: ReminderPatch, guard?: { ifHandledThrough: Date }): Promise<ReminderView> {
  const at = nowOf(d)
  const updated = await d.store.update(userId, id, { ...p, updatedAt: at }, guard)
  if (!updated) {
    if (guard) throw new ReminderError('conflict', 'The reminder changed meanwhile; look again.')
    throw new ReminderError('not_found', 'Reminder not found.')
  }
  return view(updated, at)
}

export async function createReminder(
  d: ReminderDeps,
  actor: ReminderActor,
  input: { title: string; note?: string; weekdays: readonly string[]; time: string; timeZone?: string },
): Promise<ReminderView> {
  const t = title(input.title)
  const n = note(input.note)
  const s = schedule({ weekdays: input.weekdays, time: input.time, timeZone: input.timeZone ?? (await d.timeZoneOf(actor.userId)) })
  if ((await d.store.list(actor.userId)).length >= REMINDER_LIMIT) {
    throw new ReminderError('invalid', `A person keeps at most ${REMINDER_LIMIT} reminders; delete one you no longer need first.`)
  }
  const at = nowOf(d)
  const r: Reminder = {
    id: newIdOf(d),
    userId: actor.userId,
    title: t,
    note: n,
    ...s,
    status: 'active',
    handledThrough: at,
    snoozedUntil: null,
    createdVia: actor.via,
    createdAt: at,
    updatedAt: at,
  }
  await d.store.insert(r)
  return view(r, at)
}

export async function listReminders(d: ReminderDeps, userId: string): Promise<ReminderView[]> {
  const at = nowOf(d)
  return (await d.store.list(userId)).map((r) => view(r, at))
}

/** Needs you: the person's active reminders with an open occurrence and no running snooze, oldest occurrence first. */
export async function needsYouReminders(d: ReminderDeps, userId: string): Promise<ReminderView[]> {
  return (await listReminders(d, userId))
    .filter((r) => r.due !== null && r.snoozedUntil === null)
    .sort((a, b) => a.due!.oldestAt.localeCompare(b.due!.oldestAt))
}

export async function updateReminder(
  d: ReminderDeps,
  userId: string,
  id: string,
  input: { title?: string; note?: string; weekdays?: readonly string[]; time?: string; timeZone?: string },
): Promise<ReminderView> {
  if (Object.values(input).every((v) => v === undefined)) {
    throw new ReminderError('invalid', 'Give at least one of title, note, weekdays, time or time zone to change.')
  }
  const r = await own(d, userId, id)
  const p: ReminderPatch = {}
  if (input.title !== undefined) p.title = title(input.title)
  if (input.note !== undefined) p.note = note(input.note)
  if (input.weekdays !== undefined || input.time !== undefined || input.timeZone !== undefined) {
    const s = schedule({ weekdays: input.weekdays ?? r.weekdays, time: input.time ?? r.time, timeZone: input.timeZone ?? r.timeZone })
    const changed = s.weekdays.join() !== r.weekdays.join() || s.time !== r.time || s.timeZone !== r.timeZone
    if (changed) Object.assign(p, s, { handledThrough: nowOf(d), snoozedUntil: null })
  }
  return patch(d, userId, id, p)
}

export async function pauseReminder(d: ReminderDeps, userId: string, id: string): Promise<ReminderView> {
  const r = await own(d, userId, id)
  if (r.status === 'paused') throw new ReminderError('conflict', `'${r.title}' is already paused.`)
  return patch(d, userId, id, { status: 'paused', snoozedUntil: null })
}

export async function resumeReminder(d: ReminderDeps, userId: string, id: string): Promise<ReminderView> {
  const r = await own(d, userId, id)
  if (r.status === 'active') throw new ReminderError('conflict', `'${r.title}' is not paused.`)
  return patch(d, userId, id, { status: 'active', handledThrough: nowOf(d), snoozedUntil: null })
}

export async function deleteReminder(d: ReminderDeps, userId: string, id: string): Promise<{ id: string; title: string }> {
  const r = await own(d, userId, id)
  if (!(await d.store.delete(userId, id))) throw new ReminderError('not_found', 'Reminder not found.')
  return { id: r.id, title: r.title }
}

/** Tick off the oldest open occurrence (or all open ones); a running snooze ends. */
export async function completeReminder(d: ReminderDeps, userId: string, id: string, opts: { all?: boolean } = {}): Promise<ReminderView> {
  const r = await own(d, userId, id)
  const at = nowOf(d)
  const due = r.status === 'active' ? dueOccurrences(scheduleOf(r), r.handledThrough, at) : null
  if (!due) {
    const next = r.status === 'active' ? ` The next one is ${nextOccurrence(scheduleOf(r), at).toISOString()}.` : ''
    throw new ReminderError('conflict', `Nothing is due on '${r.title}'.${next}`)
  }
  return patch(d, userId, id, { handledThrough: opts.all ? due.latest : due.oldest, snoozedUntil: null }, { ifHandledThrough: r.handledThrough })
}

/** Hide the reminder from Needs you for `minutes`, or until an instant (ISO 8601) — within 30 days. */
export async function snoozeReminder(d: ReminderDeps, userId: string, id: string, input: { minutes?: number; until?: string }): Promise<ReminderView> {
  if ((input.minutes === undefined) === (input.until === undefined)) {
    throw new ReminderError('invalid', 'Snooze takes either minutes or until (an ISO 8601 instant), not both or neither.')
  }
  const r = await own(d, userId, id)
  if (r.status === 'paused') throw new ReminderError('conflict', `'${r.title}' is paused; resume it before snoozing.`)
  const at = nowOf(d)
  let until: Date
  if (input.minutes !== undefined) {
    if (!Number.isInteger(input.minutes) || input.minutes < 1) throw new ReminderError('invalid', 'Snooze minutes must be a whole number of at least 1.')
    until = new Date(at.getTime() + input.minutes * 60_000)
  } else {
    until = new Date(input.until!)
    if (Number.isNaN(until.getTime())) throw new ReminderError('invalid', `until must be an ISO 8601 instant (got ${JSON.stringify(input.until)}).`)
    if (until.getTime() <= at.getTime()) throw new ReminderError('invalid', 'A snooze must end in the future.')
  }
  if (until.getTime() - at.getTime() > SNOOZE_MAX_MS) throw new ReminderError('invalid', 'A snooze lasts at most 30 days; pause the reminder for longer.')
  return patch(d, userId, id, { snoozedUntil: until })
}
