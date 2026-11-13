import type { EventInput } from './service'
import type { OccurrenceDto, ProposalDto, Visibility } from './types'
import { CalendarError } from './errors'
import { formatRrule, parseRrule, WEEKDAYS, type Freq, type Recurrence, type Weekday } from './recurrence'
import { localSpan, localOf, parseWall } from './time'

/**
 * The event dialog's data (pure; server and browser): what it starts with
 * (a draft), the repeat choices ↔ RRULE, and its posted form → the service's
 * EventInput. Validation is the service's; this only maps fields.
 */

export type RepeatForm = {
  freq: 'none' | Freq
  interval: number
  /** Weekly: the days (none = the start's weekday). */
  days: Weekday[]
  end: 'never' | 'on' | 'after'
  /** `YYYY-MM-DD`, for end = on. */
  until: string
  /** For end = after. */
  count: number
  /** A rule the dialog doesn't build (e.g. from a synced calendar): kept as it is unless the person picks another. */
  custom: string | null
}

export const NO_REPEAT: RepeatForm = { freq: 'none', interval: 1, days: [], end: 'never', until: '', count: 10, custom: null }

export function repeatFromRrule(rrule: string | null): RepeatForm {
  if (!rrule) return { ...NO_REPEAT }
  const r = parseRrule(rrule)
  const form: RepeatForm = {
    freq: r.freq,
    interval: r.interval,
    days: [...(r.byDay ?? [])],
    end: r.count !== undefined ? 'after' : r.until ? 'on' : 'never',
    until: r.until?.kind === 'day' ? r.until.day : r.until ? r.until.at.toISOString().slice(0, 10) : '',
    count: r.count ?? NO_REPEAT.count,
    custom: null,
  }
  const builds = r.byNthDay === undefined && r.byMonthDay === undefined && r.until?.kind !== 'instant'
  return builds ? form : { ...form, custom: formatRrule(r) }
}

export function repeatToRrule(form: RepeatForm): string | null {
  if (form.custom) return form.custom
  if (form.freq === 'none') return null
  const r: Recurrence = { freq: form.freq, interval: form.interval }
  if (form.freq === 'WEEKLY' && form.days.length > 0) r.byDay = WEEKDAYS.filter((d) => form.days.includes(d))
  if (form.end === 'on') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.until)) throw new CalendarError('invalid', 'Say on which day the repeating ends.')
    r.until = { kind: 'day', day: form.until }
  }
  if (form.end === 'after') {
    if (!Number.isInteger(form.count) || form.count < 1) throw new CalendarError('invalid', 'Say after how many times the repeating ends.')
    r.count = form.count
  }
  return formatRrule(r)
}

/** What the dialog starts with. */
export type EventDraft = {
  /** The event to change (a series for one of its instances); null = a new event. */
  id: string | null
  /** An instance of a series: its start (offered: this event / all events). */
  occurrenceStart: string | null
  inSeries: boolean
  canEdit: boolean
  ownerName: string | null
  title: string
  allDay: boolean
  startDay: string
  startTime: string
  endDay: string
  endTime: string
  /** The series' own first time (shown when "all events" is picked). */
  series: { startDay: string; startTime: string; endDay: string; endTime: string } | null
  timeZone: string
  location: string
  notes: string
  visibility: Visibility
  repeat: RepeatForm
  guests: string[]
  /** Every guest's name, for the read-only view. */
  guestLabels: string[]
  externalGuests: Array<{ email: string; name: string | null }>
  /** An appointment found in mail (K7): Save accepts it (the event + the invitation). */
  proposalId: string | null
}

function plusHour(day: string, time: string): { day: string; time: string } {
  const wall = parseWall(`${day}T${time}`)
  if (!wall) throw new Error(`not a wall time: ${day} ${time}`)
  const next = wall.add({ hours: 1 })
  const pad = (n: number) => String(n).padStart(2, '0')
  return { day: next.toString().slice(0, 10), time: `${pad(next.hour)}:${pad(next.minute)}` }
}

export function newDraft(at: { day: string; time: string | null; timeZone: string; visibility: Visibility }): EventDraft {
  const startTime = at.time ?? '09:00'
  const end = plusHour(at.day, startTime)
  return {
    id: null,
    occurrenceStart: null,
    inSeries: false,
    canEdit: true,
    ownerName: null,
    title: '',
    allDay: false,
    startDay: at.day,
    startTime,
    endDay: end.day,
    endTime: end.time,
    series: null,
    timeZone: at.timeZone,
    location: '',
    notes: '',
    visibility: at.visibility,
    repeat: { ...NO_REPEAT },
    guests: [],
    guestLabels: [],
    externalGuests: [],
    proposalId: null,
  }
}

function parts(span: { start: string; end: string }, allDay: boolean) {
  if (allDay) return { startDay: span.start, startTime: '09:00', endDay: span.end, endTime: '10:00' }
  return { startDay: span.start.slice(0, 10), startTime: span.start.slice(11), endDay: span.end.slice(0, 10), endTime: span.end.slice(11) }
}

/** The draft for an occurrence the person sees in full. */
export function editDraft(occ: OccurrenceDto): EventDraft {
  const e = occ.event
  if (!e) throw new Error('editDraft needs an occurrence seen in full')
  const inSeries = e.rrule !== null
  const instance = parts(localSpan(occ.start, occ.end, e.timeZone, e.allDay), e.allDay)
  return {
    id: e.id,
    occurrenceStart: inSeries ? occ.occurrenceStart : null,
    inSeries,
    canEdit: e.canEdit,
    ownerName: e.ownerName,
    title: e.title,
    allDay: e.allDay,
    ...instance,
    series: inSeries ? parts({ start: e.localStart, end: e.localEnd }, e.allDay) : null,
    timeZone: e.timeZone,
    location: e.location ?? '',
    notes: e.notes ?? '',
    visibility: e.visibility,
    repeat: repeatFromRrule(e.rrule),
    guests: e.attendees.filter((a) => a.memberId !== null).map((a) => a.memberId!),
    guestLabels: e.attendees.map((a) => a.name),
    externalGuests: e.attendees.filter((a) => a.email !== null).map((a) => ({ email: a.email!, name: a.name === a.email ? null : a.name })),
    proposalId: null,
  }
}

/**
 * The dialog for an appointment found in mail (Edit): prefilled as Accept
 * would create it — the call's link as the place (or in the notes beside a
 * place), the people from the mail as guests outside the company.
 */
export function proposalDraft(p: ProposalDto, visibility: Visibility): EventDraft {
  return {
    ...newDraft({ day: p.localStart.slice(0, 10), time: p.localStart.slice(11), timeZone: p.timeZone, visibility }),
    title: p.title,
    endDay: p.localEnd.slice(0, 10),
    endTime: p.localEnd.slice(11),
    location: p.location ?? p.call ?? '',
    notes: p.location && p.call ? p.call : '',
    externalGuests: p.attendees.map((g) => ({ email: g.email, name: g.name })),
    proposalId: p.id,
  }
}

const text = (form: FormData, key: string): string => {
  const v = form.get(key)
  return typeof v === 'string' ? v : ''
}
const all = (form: FormData, key: string): string[] => form.getAll(key).filter((v): v is string => typeof v === 'string')

/** The posted dialog → which event (and instance) and the service input. */
export function eventFormInput(form: FormData): { id: string | null; occurrenceStart: string | null; proposalId: string | null; input: EventInput } {
  const allDay = form.get('allDay') === 'on'
  const one = text(form, 'scope') === 'one'
  const input: EventInput = {
    title: text(form, 'title'),
    allDay,
    start: allDay ? text(form, 'startDay') : `${text(form, 'startDay')}T${text(form, 'startTime')}`,
    end: allDay ? text(form, 'endDay') : `${text(form, 'endDay')}T${text(form, 'endTime')}`,
    timeZone: text(form, 'timeZone'),
    location: text(form, 'location'),
    notes: text(form, 'notes'),
    visibility: text(form, 'visibility'),
  }
  if (!one) {
    const freq = text(form, 'repeat')
    const repeat: RepeatForm = {
      freq: (freq === '' ? 'none' : freq) as RepeatForm['freq'],
      interval: Number(text(form, 'repeatInterval') || '1'),
      days: all(form, 'repeatDay') as Weekday[],
      end: (text(form, 'repeatEnd') || 'never') as RepeatForm['end'],
      until: text(form, 'repeatUntil'),
      count: Number(text(form, 'repeatCount') || '0'),
      custom: freq === 'custom' ? text(form, 'repeatCustom') : null,
    }
    input.rrule = repeatToRrule(repeat)
    const emails = all(form, 'guestEmail')
    const names = all(form, 'guestEmailName')
    input.attendees = [
      ...all(form, 'guest').map((memberId) => ({ memberId })),
      ...emails.map((email, i) => (names[i] ? { email, name: names[i] } : { email })),
    ]
  }
  const id = text(form, 'id')
  const proposalId = text(form, 'proposalId')
  return { id: id === '' ? null : id, occurrenceStart: one ? text(form, 'occurrenceStart') : null, proposalId: proposalId === '' ? null : proposalId, input }
}

/** Today in a zone (`YYYY-MM-DD`). */
export function todayIn(timeZone: string, at: Date = new Date()): string {
  return localOf(at, timeZone).day
}
