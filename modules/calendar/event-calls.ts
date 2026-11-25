import type { CalendarDeps, EventInput } from './service'
import type { EventDto } from './types'
import { CalendarError } from './errors'
import { assertOwner, createEvent, eventDto, membersById, viewerOf, visibleRow, type Actor } from './service'

/**
 * A call on an event (plan/calendar.md K3, Contribute df14e05a: "call
 * straight from the event"). An event carries at most one Calls meeting
 * (`call_id`): booked for the event's own slot with its guests — colleagues
 * join from the event, people outside get the call link by email (Calls'
 * invitation) — or a call the person is already in, linked. Join opens the
 * call screen (`joinUrl`), from the event and from its reminder.
 *
 * Calls is another module: the calendar reaches it through this port, wired
 * outside modules/ (src/lib/server/calendar/calls-port.ts), never by import.
 * Only timed events that don't repeat carry a call (a booked meeting has one
 * slot); while it has one, the event keeps its time (calendar service).
 */

export type CallBooking = {
  title: string
  startsAt: Date
  durationMinutes: number
  /** Colleagues to invite (member guests who did not decline). */
  memberIds: string[]
  /** People outside the company (their addresses): they get the call link by email. */
  guests: string[]
  /** The event's zone: the invitation shows times in it. */
  timeZone: string
  /** Another provider's link (Zoom, Teams, Meet …) instead of a room of our own. */
  externalUrl: string | null
}

export type CalendarCallsPort = {
  /** Book a meeting as this person (calls.schedule). A refusal is a CalendarError with Calls' reason. */
  book(userId: string, input: CallBooking): Promise<{ callId: string; invited: number }>
  /** Whether the person is in this call (can see and join it). */
  canJoin(userId: string, callId: string): Promise<boolean>
}

const invalid = (message: string) => new CalendarError('invalid', message)

function callsOf(d: CalendarDeps): CalendarCallsPort {
  if (!d.calls) throw new Error('calendar: no Calls port is wired (CalendarDeps.calls), so an event cannot carry a call')
  return d.calls
}

function optionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.trim().length > 200) throw invalid(`${label} must be text`)
  return value.trim()
}

/**
 * Add a call to the person's own event: link `callId` (a call they are in),
 * or book one for the event's slot (`externalUrl`: on another provider).
 */
export async function addCall(
  d: CalendarDeps,
  actor: Actor,
  rawId: unknown,
  input: { callId?: unknown; externalUrl?: unknown },
): Promise<EventDto> {
  const v = await viewerOf(d, actor)
  const { row, guests } = await visibleRow(d, v, rawId)
  assertOwner(v, row)
  if (row.callId !== null) throw invalid('This event already has a call: join it from the event, or remove it first.')
  if (row.allDay) throw invalid('A call needs a start time: an all-day event has none.')
  if (row.rrule !== null || row.recurrenceId !== null) throw invalid('A repeating event can’t carry a call yet: a booked call has one time.')
  const owner = row.ownerId
  const linked = optionalId(input.callId, 'A call id')
  const externalUrl = optionalId(input.externalUrl, 'A call link')
  if (linked !== null && externalUrl !== null) throw invalid('Link a call or give another provider’s link, not both.')
  const calls = callsOf(d)
  let callId: string
  let invited = 0
  if (linked !== null) {
    if (!(await calls.canJoin(owner, linked))) throw new CalendarError('not_found', 'call not found')
    callId = linked
  } else {
    const memberIds = guests.filter((g) => g.memberId !== null && g.rsvp !== 'declined').map((g) => g.memberId!)
    const emails = guests.filter((g) => g.email !== null && g.rsvp !== 'declined').map((g) => g.email!)
    if (memberIds.length === 0 && emails.length === 0) throw invalid('Add a guest first: a call needs someone to call.')
    const booked = await calls.book(owner, {
      title: row.title,
      startsAt: row.startsAt,
      durationMinutes: Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000),
      memberIds,
      guests: emails,
      timeZone: row.timeZone,
      externalUrl,
    })
    callId = booked.callId
    invited = booked.invited
  }
  const at = d.now ? d.now() : new Date()
  await d.store.updateEvent(row.id, { callId, updatedAt: at })
  await d.audit({ type: 'calendar.call_added', principalId: v.principalId, payload: { id: row.id, booked: linked === null, invited } })
  return eventDto({ ...row, callId, updatedAt: at }, guests, await membersById(d), v)
}

/** Take the call off the person's own event. The meeting itself stays booked (calls.end ends it). */
export async function removeCall(d: CalendarDeps, actor: Actor, rawId: unknown): Promise<EventDto> {
  const v = await viewerOf(d, actor)
  const { row, guests } = await visibleRow(d, v, rawId)
  assertOwner(v, row)
  if (row.callId === null) throw invalid('This event has no call.')
  const at = d.now ? d.now() : new Date()
  await d.store.updateEvent(row.id, { callId: null, updatedAt: at })
  await d.audit({ type: 'calendar.call_removed', principalId: v.principalId, payload: { id: row.id } })
  return eventDto({ ...row, callId: null, updatedAt: at }, guests, await membersById(d), v)
}

/**
 * A new event with a call (the dialog's "With a video call"): the event is
 * made, then the call booked for it; when booking fails the event is taken
 * back out, so nothing half-made stays.
 */
export async function createEventWithCall(
  d: CalendarDeps,
  actor: Actor,
  input: EventInput,
  call: { externalUrl?: unknown },
): Promise<EventDto> {
  const event = await createEvent(d, actor, input)
  try {
    return await addCall(d, actor, event.id, call)
  } catch (err) {
    const row = await d.store.getEvent(event.id)
    if (row) {
      await d.store.deleteEvent(row.id)
      await d.audit({ type: 'calendar.event_deleted', principalId: (await viewerOf(d, actor)).principalId, payload: { id: row.id } })
    }
    throw err
  }
}
