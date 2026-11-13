import type { AttendeeRow, CalendarStore, EventPatch, EventRow } from './store'
import { randomUUID } from 'node:crypto'
import type { MemberRole } from '$lib/server/auth/user-role'
import { CalendarError } from './errors'
import { expandSeries, formatRrule, isInstanceStart, parseRrule, RecurrenceError, seriesEnd, type Recurrence, type SeriesTiming } from './recurrence'
import { dayStart, isTimeZone, localSpan, parseDay, parseWall, wallToInstant } from './time'
import {
  ATTENDEE_ROLES,
  CALENDAR_LIMITS,
  DEFAULT_VISIBILITY,
  EVENT_STATUSES,
  LIMITED_TITLE,
  VISIBILITIES,
  type AttendeeDto,
  type AttendeeRole,
  type BusyBlockDto,
  type EventDto,
  type EventSource,
  type EventStatus,
  type FreeBusyDto,
  type OccurrenceDto,
  type Visibility,
} from './types'

/**
 * Calendar core (plan/calendar.md K1). Who sees what is decided here, server
 * side, on every call — the tables carry no RLS, like Contacts':
 * - every member has their own calendar; the owner of an event and its
 *   member guests see it in full; only its owner changes or deletes it;
 * - everyone else sees, per event: the title + time (company), "Busy" + time
 *   (busy) or "Out of office" + time (private) — and only as availability
 *   (freeBusy); they never find the event itself;
 * - the company owner and admins get no extra view of anyone's events;
 * - the agent sees what the person it works for sees (tools.ts makes it that
 *   person); on its own it has no calendar and sees availability like a
 *   colleague.
 * Events a person can't see answer `not_found`, as if they didn't exist.
 * Kernel events carry ids and counts only — never titles, notes or guests.
 */

export type Actor = { kind: 'user'; userId: string } | { kind: 'agent'; id: string }

export type CalendarAudit = (event: { type: string; principalId: string; payload: Record<string, unknown> }) => Promise<void>

export type CalendarMember = { id: string; name: string; email: string }

export type CalendarDeps = {
  store: CalendarStore
  /** The people in the company. */
  members: () => Promise<CalendarMember[]>
  /** The person's company role, or null when no such user exists. */
  roleOf: (userId: string) => Promise<MemberRole | null>
  audit: CalendarAudit
  now?: () => Date
  newId?: () => string
}

/**
 * An event's fields as they arrive from the dialog, a tool, or a later
 * stream (validated here). Timing is one group: `allDay`, `start`, `end`
 * (wall times `YYYY-MM-DDTHH:mm`, or days `YYYY-MM-DD` with an inclusive end
 * for an all-day event) and `timeZone` (IANA). Guests are members
 * (`{ memberId }`) or people outside the company (`{ email, name? }`).
 */
export type EventInput = {
  title?: unknown
  notes?: unknown
  location?: unknown
  allDay?: unknown
  start?: unknown
  end?: unknown
  timeZone?: unknown
  visibility?: unknown
  status?: unknown
  /** RRULE text (supported subset, see recurrence.ts); null = not repeating. */
  rrule?: unknown
  attendees?: unknown
  /** A Calls meeting id (K3). */
  callId?: unknown
}

/** Where a new event comes from: made here, or accepted from an email proposal (K7: externalId = the message id). */
export type EventOrigin = { source: Extract<EventSource, 'local' | 'email_proposal'>; externalId?: string }

/** Which instance of a series a change or delete is for; leave it out for the whole event or series. */
export type InstanceScope = { occurrenceStart?: unknown }

const now = (d: CalendarDeps) => (d.now ? d.now() : new Date())
const newId = (d: CalendarDeps) => (d.newId ? d.newId() : randomUUID())
const invalid = (message: string) => new CalendarError('invalid', message)

// ── boundary parsing (fail loud with the constraint) ──────────────────────────

function parseTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid('Give the event a title.')
  const title = value.trim()
  if (title.length > CALENDAR_LIMITS.title) throw invalid(`A title can be at most ${CALENDAR_LIMITS.title} characters.`)
  return title
}

/** Optional text: undefined = not sent, null or blank = clear it. */
function optionalText(value: unknown, label: string, max: number, opts: { trim?: boolean } = {}): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw invalid(`${label} must be text`)
  if (value.trim() === '') return null
  const text = opts.trim === false ? value : value.trim()
  if (text.length > max) throw invalid(`${label} can be at most ${max} characters.`)
  return text
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`${label} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value ?? null)}`)
  }
  return value as T
}

type Timing = { startsAt: Date; endsAt: Date; timeZone: string; allDay: boolean }

/** The timing group (required on create; on update undefined when none of it is sent, all four parts otherwise). */
function parseTiming(input: EventInput, mode: 'create' | 'update'): Timing | undefined {
  const sent = [input.allDay, input.start, input.end, input.timeZone].filter((v) => v !== undefined).length
  if (sent === 0 && mode === 'update') return undefined
  if (sent !== 4 && mode === 'update') throw invalid('Send start, end, allDay and timeZone together.')
  if (input.allDay !== undefined && typeof input.allDay !== 'boolean') throw invalid('allDay must be true or false')
  if (!isTimeZone(input.timeZone)) {
    throw invalid(`Say which time zone the event is in (an IANA name such as Europe/Berlin), got ${JSON.stringify(input.timeZone ?? null)}`)
  }
  const timeZone = input.timeZone
  if (input.allDay === true) {
    const first = parseDay(input.start)
    const last = parseDay(input.end)
    if (!first || !last) throw invalid('An all-day event’s start and end must be days (YYYY-MM-DD).')
    if (last.compare(first) < 0) throw invalid('An event can’t end before it starts.')
    return { startsAt: dayStart(first, timeZone), endsAt: dayStart(last.add({ days: 1 }), timeZone), timeZone, allDay: true }
  }
  const start = parseWall(input.start)
  const end = parseWall(input.end)
  if (!start || !end) throw invalid('An event’s start and end must be wall times (YYYY-MM-DDTHH:mm).')
  const startsAt = wallToInstant(start, timeZone)
  const endsAt = wallToInstant(end, timeZone)
  if (endsAt.getTime() <= startsAt.getTime()) throw invalid('An event must end after it starts.')
  return { startsAt, endsAt, timeZone, allDay: false }
}

/** undefined = not sent; null = not repeating; else the parsed rule and its canonical text. */
function parseRule(value: unknown): { text: string; rule: Recurrence } | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw invalid('rrule must be RRULE text such as FREQ=WEEKLY;BYDAY=MO, or null')
  try {
    const rule = parseRrule(value)
    return { text: formatRrule(rule), rule }
  } catch (err) {
    if (err instanceof RecurrenceError) throw invalid(`The repeat rule can’t be used: ${err.message}`)
    throw err
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type GuestInput = { memberId: string | null; email: string | null; name: string | null; role: AttendeeRole }

function parseAttendees(value: unknown, ownerId: string, members: Map<string, CalendarMember>): GuestInput[] {
  if (!Array.isArray(value)) throw invalid('attendees must be a list of {memberId} or {email, name?}')
  if (value.length > CALENDAR_LIMITS.attendees) throw invalid(`At most ${CALENDAR_LIMITS.attendees} guests per event.`)
  const out: GuestInput[] = []
  const seen = new Set<string>()
  for (const raw of value as unknown[]) {
    const g = (raw && typeof raw === 'object' ? raw : {}) as { memberId?: unknown; email?: unknown; name?: unknown; role?: unknown }
    const role = g.role === undefined ? 'required' : oneOf(g.role, ATTENDEE_ROLES, 'A guest’s role')
    if ((g.memberId === undefined) === (g.email === undefined)) {
      throw invalid('A guest is either a member of the company (memberId) or an email address (email).')
    }
    if (g.memberId !== undefined) {
      if (typeof g.memberId !== 'string' || !members.has(g.memberId)) throw invalid(`${JSON.stringify(g.memberId)} is not in the company`)
      if (g.memberId === ownerId) throw invalid('You don’t invite yourself: it is your own event.')
      if (seen.has(`m:${g.memberId}`)) continue
      seen.add(`m:${g.memberId}`)
      out.push({ memberId: g.memberId, email: null, name: null, role })
      continue
    }
    const email = typeof g.email === 'string' ? g.email.trim().toLowerCase() : ''
    if (!EMAIL.test(email) || email.length > CALENDAR_LIMITS.email) throw invalid(`${JSON.stringify(g.email)} is not an email address`)
    const name = optionalText(g.name, 'A guest’s name', CALENDAR_LIMITS.attendeeName) ?? null
    if (seen.has(`e:${email}`)) continue
    seen.add(`e:${email}`)
    out.push({ memberId: null, email, name, role })
  }
  return out
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseEventId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value.trim())) {
    throw invalid(`id must be an event id (UUID), got ${JSON.stringify(value ?? null)}`)
  }
  return value.trim().toLowerCase()
}

function parseInstant(value: unknown, label: string): Date {
  const at = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : null
  if (!at || Number.isNaN(at.getTime())) throw invalid(`${label} must be an ISO date-time, got ${JSON.stringify(value ?? null)}`)
  return at
}

/** A read range: [from, to), at most CALENDAR_LIMITS.rangeDays long. */
export function parseRange(input: { from?: unknown; to?: unknown }): { from: Date; to: Date } {
  const from = parseInstant(input.from, 'from')
  const to = parseInstant(input.to, 'to')
  if (to.getTime() <= from.getTime()) throw invalid('The range must end after it starts.')
  if (to.getTime() - from.getTime() > CALENDAR_LIMITS.rangeDays * 86_400_000) {
    throw invalid(`A calendar read covers at most ${CALENDAR_LIMITS.rangeDays} days.`)
  }
  return { from, to }
}

// ── who is looking ────────────────────────────────────────────────────────────

type Viewer = { principalId: string; userId: string | null }

async function viewerOf(d: CalendarDeps, actor: Actor): Promise<Viewer> {
  if (actor.kind === 'agent') return { principalId: actor.id, userId: null }
  if (!(await d.roleOf(actor.userId))) throw new CalendarError('forbidden', 'Only people in the company have a calendar.')
  return { principalId: actor.userId, userId: actor.userId }
}

/** The person whose calendar this is (the agent on its own has none). */
function personOf(v: Viewer): string {
  if (v.userId === null) throw new CalendarError('forbidden', 'The agent works in a person’s calendar; on its own it only sees availability.')
  return v.userId
}

const seriesKey = (row: EventRow) => row.recurrenceId ?? row.id

async function guestsByEvent(d: CalendarDeps, rows: readonly EventRow[]): Promise<Map<string, AttendeeRow[]>> {
  const ids = [...new Set(rows.map(seriesKey))]
  const out = new Map<string, AttendeeRow[]>(ids.map((id) => [id, []]))
  if (ids.length === 0) return out
  for (const g of await d.store.attendees(ids)) out.get(g.eventId)?.push(g)
  for (const list of out.values()) list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  return out
}

const isGuest = (guests: readonly AttendeeRow[], userId: string) => guests.some((g) => g.memberId === userId)

/** The event as its owner or a member guest reads it; null for anyone else. */
async function visibleRow(d: CalendarDeps, v: Viewer, rawId: unknown): Promise<{ row: EventRow; guests: AttendeeRow[] }> {
  const row = await d.store.getEvent(parseEventId(rawId))
  if (row && v.userId !== null) {
    const guests = (await guestsByEvent(d, [row])).get(seriesKey(row)) ?? []
    if (row.ownerId === v.userId || isGuest(guests, v.userId)) return { row, guests }
  }
  throw new CalendarError('not_found', 'event not found')
}

function assertOwner(v: Viewer, row: EventRow): void {
  if (row.ownerId !== v.userId) throw new CalendarError('forbidden', 'Only the person whose calendar it is changes or deletes this event.')
}

// ── views ─────────────────────────────────────────────────────────────────────

const nameOf = (members: Map<string, CalendarMember>, id: string) => members.get(id)?.name || members.get(id)?.email || 'a former member'

function attendeeDto(g: AttendeeRow, members: Map<string, CalendarMember>): AttendeeDto {
  return {
    memberId: g.memberId,
    email: g.email,
    name: g.memberId !== null ? nameOf(members, g.memberId) : (g.name ?? g.email!),
    role: g.role,
    rsvp: g.rsvp,
  }
}

function eventDto(row: EventRow, guests: readonly AttendeeRow[], members: Map<string, CalendarMember>, v: Viewer): EventDto {
  const local = localSpan(row.startsAt, row.endsAt, row.timeZone, row.allDay)
  return {
    id: row.id,
    ownerId: row.ownerId,
    ownerName: nameOf(members, row.ownerId),
    title: row.title,
    notes: row.notes,
    location: row.location,
    start: row.startsAt.toISOString(),
    end: row.endsAt.toISOString(),
    allDay: row.allDay,
    timeZone: row.timeZone,
    localStart: local.start,
    localEnd: local.end,
    visibility: row.visibility,
    status: row.status,
    rrule: row.rrule,
    seriesId: row.recurrenceId,
    originalStart: row.originalStart?.toISOString() ?? null,
    attendees: guests.map((g) => attendeeDto(g, members)),
    callId: row.callId,
    source: row.source,
    canEdit: v.userId !== null && row.ownerId === v.userId,
  }
}

async function membersById(d: CalendarDeps): Promise<Map<string, CalendarMember>> {
  return new Map((await d.members()).map((m) => [m.id, m]))
}

const timingOf = (row: EventRow): SeriesTiming => ({ startsAt: row.startsAt, endsAt: row.endsAt, timeZone: row.timeZone, allDay: row.allDay })

/** A row's stored rule (written only by this service; a bad one fails loud). */
function storedRule(row: EventRow): Recurrence {
  try {
    return parseRrule(row.rrule!)
  } catch (err) {
    throw new Error(`calendar event ${row.id} has an unusable rrule: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}

type Occurrence = { row: EventRow; start: Date; end: Date; occurrenceStart: Date | null }

/** Every occurrence the rows put into [from, to): singles, series instances (minus removed and changed ones), changed instances. */
function occurrences(rows: readonly EventRow[], window: { from: Date; to: Date }): Occurrence[] {
  const changed = new Map<string, Date[]>()
  for (const r of rows) if (r.recurrenceId !== null) changed.set(r.recurrenceId, [...(changed.get(r.recurrenceId) ?? []), r.originalStart!])
  const overlaps = (s: Date, e: Date) => s.getTime() < window.to.getTime() && e.getTime() > window.from.getTime()
  const out: Occurrence[] = []
  for (const row of rows) {
    if (row.recurrenceId !== null) {
      if (overlaps(row.startsAt, row.endsAt)) out.push({ row, start: row.startsAt, end: row.endsAt, occurrenceStart: row.originalStart })
    } else if (row.rrule === null) {
      if (overlaps(row.startsAt, row.endsAt)) out.push({ row, start: row.startsAt, end: row.endsAt, occurrenceStart: null })
    } else {
      const removed = [...row.exdates, ...(changed.get(row.id) ?? [])]
      for (const inst of expandSeries(timingOf(row), storedRule(row), window, { exdates: removed })) {
        out.push({ row, start: inst.start, end: inst.end, occurrenceStart: inst.start })
      }
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.row.title.localeCompare(b.row.title) || a.row.id.localeCompare(b.row.id))
}

// ── reads ─────────────────────────────────────────────────────────────────────

/**
 * The person's own calendar in [from, to): their events and the ones they are
 * a member guest of, in full, one entry per occurrence (cancelled ones left
 * out). Owner/admin rights add nothing.
 */
export async function listCalendar(d: CalendarDeps, actor: Actor, rawRange: { from?: unknown; to?: unknown }): Promise<OccurrenceDto[]> {
  const window = parseRange(rawRange)
  const v = await viewerOf(d, actor)
  const me = personOf(v)
  const rows = await d.store.inRange([me], window.from, window.to)
  const [guests, members] = await Promise.all([guestsByEvent(d, rows), membersById(d)])
  const series = new Map(rows.map((r) => [r.id, r]))
  return occurrences(rows, window)
    .filter((o) => o.row.status !== 'cancelled')
    .map((o) => {
      const content = o.row
      const event = eventDto(content, guests.get(seriesKey(content)) ?? [], members, v)
      const { rrule } = series.get(seriesKey(content)) ?? content
      return {
        key: `${content.id}:${o.start.getTime()}`,
        start: o.start.toISOString(),
        end: o.end.toISOString(),
        allDay: content.allDay,
        ownerId: content.ownerId,
        ownerName: event.ownerName,
        view: 'full' as const,
        title: content.title,
        status: content.status,
        occurrenceStart: rrule !== null || content.recurrenceId !== null ? o.occurrenceStart!.toISOString() : null,
        event,
      }
    })
}

export async function getEvent(d: CalendarDeps, actor: Actor, rawId: unknown): Promise<EventDto> {
  const v = await viewerOf(d, actor)
  const { row, guests } = await visibleRow(d, v, rawId)
  return eventDto(row, guests, await membersById(d), v)
}

/**
 * Colleagues' availability in [from, to): per member, the time their events
 * take (owned, or invited and not declined; cancelled ones take none) —
 * "busy" with the title only for a company-visible event, "out of office"
 * for a private one. Exactly the same for everyone who asks (the owner,
 * admins and the agent included).
 */
export async function freeBusy(
  d: CalendarDeps,
  actor: Actor,
  input: { memberIds?: unknown; from?: unknown; to?: unknown },
): Promise<FreeBusyDto[]> {
  const window = parseRange(input)
  await viewerOf(d, actor)
  const members = await membersById(d)
  if (!Array.isArray(input.memberIds) || input.memberIds.length === 0) throw invalid('Say whose availability to show (memberIds).')
  if (input.memberIds.length > CALENDAR_LIMITS.freeBusyMembers) throw invalid(`At most ${CALENDAR_LIMITS.freeBusyMembers} people at once.`)
  const ids = [...new Set(input.memberIds as unknown[])].map((id) => {
    if (typeof id !== 'string' || !members.has(id)) throw invalid(`${JSON.stringify(id)} is not in the company`)
    return id
  })
  const rows = await d.store.inRange(ids, window.from, window.to)
  const guests = await guestsByEvent(d, rows)
  const all = occurrences(rows, window).filter((o) => o.row.status !== 'cancelled')
  return ids.map((memberId) => ({
    memberId,
    name: nameOf(members, memberId),
    blocks: all
      .filter((o) => {
        if (o.row.ownerId === memberId) return true
        const g = (guests.get(seriesKey(o.row)) ?? []).find((x) => x.memberId === memberId)
        return g !== undefined && g.rsvp !== 'declined'
      })
      .map((o): BusyBlockDto => ({
        start: o.start.toISOString(),
        end: o.end.toISOString(),
        allDay: o.row.allDay,
        kind: o.row.visibility === 'private' ? 'out_of_office' : 'busy',
        title: o.row.visibility === 'company' ? o.row.title : null,
      })),
  }))
}

/** How a colleague sees one occurrence (exported for the pages: the label instead of the title). */
export function limitedTitle(visibility: Visibility, title: string): string {
  return visibility === 'company' ? title : LIMITED_TITLE[visibility]
}

export async function defaultVisibility(d: CalendarDeps, actor: Actor): Promise<Visibility> {
  const me = personOf(await viewerOf(d, actor))
  return (await d.store.defaultVisibility(me)) ?? DEFAULT_VISIBILITY
}

export async function setDefaultVisibility(d: CalendarDeps, actor: Actor, raw: unknown): Promise<Visibility> {
  const visibility = oneOf(raw, VISIBILITIES, 'visibility')
  const v = await viewerOf(d, actor)
  const me = personOf(v)
  await d.store.setDefaultVisibility(me, visibility, now(d))
  await d.audit({ type: 'calendar.default_visibility_set', principalId: v.principalId, payload: { visibility } })
  return visibility
}

// ── writes ────────────────────────────────────────────────────────────────────

type Fields = Partial<Pick<EventRow, 'title' | 'notes' | 'location' | 'visibility' | 'status' | 'callId'>>

/** The non-timing fields the input sends, validated (absent ones stay absent). */
function parseFields(input: EventInput): Fields {
  const out: Fields = {}
  if (input.title !== undefined) out.title = parseTitle(input.title)
  const notes = optionalText(input.notes, 'Notes', CALENDAR_LIMITS.notes, { trim: false })
  if (notes !== undefined) out.notes = notes
  const location = optionalText(input.location, 'A location', CALENDAR_LIMITS.location)
  if (location !== undefined) out.location = location
  if (input.visibility !== undefined) out.visibility = oneOf(input.visibility, VISIBILITIES, 'visibility')
  if (input.status !== undefined) out.status = oneOf<EventStatus>(input.status, EVENT_STATUSES, 'status')
  const callId = optionalText(input.callId, 'A call id', 200)
  if (callId !== undefined) out.callId = callId
  return out
}

/** The changed-field names an audit event carries, in a fixed order. */
const FIELD_ORDER = ['title', 'notes', 'location', 'time', 'visibility', 'status', 'rrule', 'attendees', 'callId'] as const

function guestRows(d: CalendarDeps, eventId: string, guests: GuestInput[], at: Date, previous: readonly AttendeeRow[] = []): AttendeeRow[] {
  return guests.map((g) => {
    const before = previous.find((p) => (g.memberId !== null ? p.memberId === g.memberId : p.email === g.email))
    return {
      id: before?.id ?? newId(d),
      eventId,
      memberId: g.memberId,
      email: g.email,
      name: g.name,
      role: g.role,
      rsvp: before?.rsvp ?? 'needs_action',
      createdAt: before?.createdAt ?? at,
      updatedAt: at,
    }
  })
}

/**
 * Add an event to the person's own calendar. Visibility defaults to the
 * person's default (busy unless they changed it). `origin` lets the email
 * proposal flow (K7) file an accepted appointment with its message id; guests
 * outside the company are stored for the invitation (K4) to go to.
 */
export async function createEvent(d: CalendarDeps, actor: Actor, input: EventInput, origin: EventOrigin = { source: 'local' }): Promise<EventDto> {
  const v = await viewerOf(d, actor)
  const owner = personOf(v)
  const title = parseTitle(input.title)
  const timing = parseTiming(input, 'create')!
  const fields = parseFields(input)
  const rule = parseRule(input.rrule) ?? null
  const members = await membersById(d)
  const guests = input.attendees === undefined || input.attendees === null ? [] : parseAttendees(input.attendees, owner, members)
  const visibility = fields.visibility ?? (await d.store.defaultVisibility(owner)) ?? DEFAULT_VISIBILITY
  const at = now(d)
  const row: EventRow = {
    id: newId(d),
    ownerId: owner,
    title,
    notes: fields.notes ?? null,
    ...timing,
    location: fields.location ?? null,
    callId: fields.callId ?? null,
    visibility,
    status: fields.status ?? 'confirmed',
    source: origin.source,
    externalId: origin.externalId ?? null,
    etag: null,
    rrule: rule?.text ?? null,
    exdates: [],
    recurrenceEndsAt: rule ? seriesEnd(timing, rule.rule) : null,
    recurrenceId: null,
    originalStart: null,
    createdBy: v.principalId,
    createdAt: at,
    updatedAt: at,
  }
  const attendees = guestRows(d, row.id, guests, at)
  await d.store.insertEvent(row, attendees)
  await d.audit({
    type: 'calendar.event_created',
    principalId: v.principalId,
    payload: { id: row.id, recurring: row.rrule !== null, guests: attendees.length, ...(origin.source !== 'local' ? { source: origin.source } : {}) },
  })
  return eventDto(row, attendees, members, v)
}

/** The series instance at `rawStart` (must be a real, not removed, instance). */
function instanceAt(series: EventRow, rawStart: unknown): { start: Date; end: Date } {
  if (series.rrule === null) throw invalid('This is not a recurring event: change it as a whole.')
  const start = parseInstant(rawStart, 'occurrenceStart')
  const rule = storedRule(series)
  const removed = series.exdates.some((x) => x.getTime() === start.getTime())
  if (removed || !isInstanceStart(timingOf(series), rule, start)) throw invalid('That time is not an instance of this series.')
  const [inst] = expandSeries(timingOf(series), rule, { from: start, to: new Date(start.getTime() + 1) })
  if (!inst || inst.start.getTime() !== start.getTime()) throw new Error(`series ${series.id}: instance ${start.toISOString()} did not expand`)
  return inst
}

/**
 * Change an event. Only the fields that are sent change; blank text or null
 * clears an optional one. For a series, `scope.occurrenceStart` changes just
 * that instance (stored as a changed instance; guests and the rule stay the
 * series'); without it the whole series changes — a new time or rule starts
 * the series over, dropping instances changed or removed one by one.
 */
export async function updateEvent(d: CalendarDeps, actor: Actor, rawId: unknown, input: EventInput, scope: InstanceScope = {}): Promise<EventDto> {
  const v = await viewerOf(d, actor)
  const { row, guests: current } = await visibleRow(d, v, rawId)
  assertOwner(v, row)
  const fields = parseFields(input)
  const timing = parseTiming(input, 'update')
  const rule = parseRule(input.rrule)
  const members = await membersById(d)
  const guests = input.attendees === undefined ? undefined : parseAttendees(input.attendees ?? [], row.ownerId, members)
  const changed = FIELD_ORDER.filter((f) =>
    f === 'time' ? timing !== undefined : f === 'rrule' ? rule !== undefined : f === 'attendees' ? guests !== undefined : f in fields,
  )
  if (changed.length === 0) throw invalid('Nothing to change.')
  const at = now(d)

  if (scope.occurrenceStart !== undefined) {
    if (guests !== undefined) throw invalid('Guests are changed for all events of a series.')
    if (rule !== undefined) throw invalid('The repeat rule is set for all events of a series.')
    const inst = instanceAt(row, scope.occurrenceStart)
    const existing = (await d.store.overrides(row.id)).find((o) => o.originalStart!.getTime() === inst.start.getTime())
    if (existing) {
      await d.store.updateEvent(existing.id, { ...fields, ...(timing ?? {}), updatedAt: at })
    } else {
      const override: EventRow = {
        ...row,
        ...fields,
        id: newId(d),
        startsAt: inst.start,
        endsAt: inst.end,
        ...(timing ?? {}),
        rrule: null,
        exdates: [],
        recurrenceEndsAt: null,
        recurrenceId: row.id,
        originalStart: inst.start,
        externalId: null,
        etag: null,
        createdBy: v.principalId,
        createdAt: at,
        updatedAt: at,
      }
      await d.store.insertEvent(override, [])
    }
    const id = existing?.id ?? (await d.store.overrides(row.id)).find((o) => o.originalStart!.getTime() === inst.start.getTime())!.id
    await d.audit({ type: 'calendar.event_updated', principalId: v.principalId, payload: { id: row.id, occurrence: true, fields: changed } })
    return eventDto((await d.store.getEvent(id))!, current, members, v)
  }

  if (row.recurrenceId !== null && (guests !== undefined || rule !== undefined)) {
    throw invalid('Guests and the repeat rule are set for all events of a series.')
  }
  const patch: EventPatch = { ...fields, ...(timing ?? {}), updatedAt: at }
  const nextRule = rule === undefined ? (row.rrule === null ? null : { text: row.rrule, rule: storedRule(row) }) : rule
  if (rule !== undefined) patch.rrule = rule?.text ?? null
  const nextTiming = timing ?? timingOf(row)
  if (row.recurrenceId === null) patch.recurrenceEndsAt = nextRule ? seriesEnd(nextTiming, nextRule.rule) : null
  const timingMoved =
    timing !== undefined &&
    (timing.startsAt.getTime() !== row.startsAt.getTime() ||
      timing.endsAt.getTime() !== row.endsAt.getTime() ||
      timing.timeZone !== row.timeZone ||
      timing.allDay !== row.allDay)
  const ruleChanged = rule !== undefined && (rule?.text ?? null) !== row.rrule
  if (row.rrule !== null && (timingMoved || ruleChanged)) {
    patch.exdates = []
    for (const o of await d.store.overrides(row.id)) await d.store.deleteEvent(o.id)
  }
  await d.store.updateEvent(row.id, patch)
  let attendees = current
  if (guests !== undefined) {
    attendees = guestRows(d, row.id, guests, at, current)
    await d.store.replaceAttendees(row.id, attendees)
  }
  await d.audit({ type: 'calendar.event_updated', principalId: v.principalId, payload: { id: row.id, fields: changed } })
  return eventDto((await d.store.getEvent(row.id))!, attendees, members, v)
}

/**
 * Delete an event (a series with all its instances), or with
 * `scope.occurrenceStart` just that instance of a series. Deleting a changed
 * instance removes that instance.
 */
export async function deleteEvent(d: CalendarDeps, actor: Actor, rawId: unknown, scope: InstanceScope = {}): Promise<void> {
  const v = await viewerOf(d, actor)
  const { row } = await visibleRow(d, v, rawId)
  assertOwner(v, row)
  const at = now(d)
  if (scope.occurrenceStart !== undefined) {
    const inst = instanceAt(row, scope.occurrenceStart)
    for (const o of await d.store.overrides(row.id)) if (o.originalStart!.getTime() === inst.start.getTime()) await d.store.deleteEvent(o.id)
    await d.store.updateEvent(row.id, { exdates: [...row.exdates, inst.start], updatedAt: at })
    await d.audit({ type: 'calendar.event_deleted', principalId: v.principalId, payload: { id: row.id, occurrence: true } })
    return
  }
  if (row.recurrenceId !== null) {
    const series = await d.store.getEvent(row.recurrenceId)
    await d.store.deleteEvent(row.id)
    if (series) await d.store.updateEvent(series.id, { exdates: [...series.exdates, row.originalStart!], updatedAt: at })
  } else {
    await d.store.deleteEvent(row.id)
  }
  await d.audit({ type: 'calendar.event_deleted', principalId: v.principalId, payload: { id: row.id } })
}
