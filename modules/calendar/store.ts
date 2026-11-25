import type { AttendeeRole, EventSource, EventStatus, Rsvp, Visibility } from './types'

/** A stored event: a single event, a series (rrule set) or a changed instance of a series (recurrenceId set). */
export type EventRow = {
  id: string
  ownerId: string
  title: string
  notes: string | null
  startsAt: Date
  endsAt: Date
  timeZone: string
  allDay: boolean
  location: string | null
  callId: string | null
  visibility: Visibility
  status: EventStatus
  source: EventSource
  externalId: string | null
  etag: string | null
  rrule: string | null
  exdates: Date[]
  recurrenceEndsAt: Date | null
  recurrenceId: string | null
  originalStart: Date | null
  /** The person, or the agent's principal id, that made it. */
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

/** A guest: a member (memberId) or someone outside the company (email, lower case). Guests of a series are the guests of all its instances. */
export type AttendeeRow = {
  id: string
  eventId: string
  memberId: string | null
  email: string | null
  name: string | null
  role: AttendeeRole
  rsvp: Rsvp
  createdAt: Date
  updatedAt: Date
}

export type EventPatch = Partial<
  Pick<
    EventRow,
    | 'title'
    | 'notes'
    | 'startsAt'
    | 'endsAt'
    | 'timeZone'
    | 'allDay'
    | 'location'
    | 'callId'
    | 'visibility'
    | 'status'
    | 'rrule'
    | 'exdates'
    | 'recurrenceEndsAt'
    | 'etag'
  >
> & { updatedAt: Date }

/**
 * Persistence seam (the DB store in production, the in-memory one in unit
 * tests). It returns rows; who may see what of them is the service's
 * decision, never the store's caller's.
 */
export type CalendarStore = {
  /** One event and its guests, together. */
  insertEvent(row: EventRow, attendees: AttendeeRow[]): Promise<void>
  getEvent(id: string): Promise<EventRow | null>
  updateEvent(id: string, patch: EventPatch): Promise<void>
  /** Deletes its changed instances and guests with it. */
  deleteEvent(id: string): Promise<void>
  replaceAttendees(eventId: string, rows: AttendeeRow[]): Promise<void>
  attendees(eventIds: readonly string[]): Promise<AttendeeRow[]>
  /** The changed instances of a series. */
  overrides(seriesId: string): Promise<EventRow[]>
  /**
   * Everything that may put time on these members' calendars in [from, to):
   * events they own or are a member guest of (a changed instance counts
   * through its series' guests) — single events overlapping the range,
   * series that start before its end and haven't ended before its start,
   * changed instances overlapping it, and every changed instance of the
   * series returned (a moved instance must hide its original).
   */
  inRange(memberIds: readonly string[], from: Date, to: Date): Promise<EventRow[]>
  defaultVisibility(memberId: string): Promise<Visibility | null>
  setDefaultVisibility(memberId: string, visibility: Visibility, at: Date): Promise<void>
  /** Whether the member's views show ISO week numbers; null when they never chose. */
  weekNumbers(memberId: string): Promise<boolean | null>
  setWeekNumbers(memberId: string, on: boolean, at: Date): Promise<void>
  /** Each member's reminder lead in minutes (null = no reminders); members who never chose are absent. */
  reminderMinutes(memberIds: readonly string[]): Promise<Map<string, number | null>>
  setReminderMinutes(memberId: string, minutes: number | null, at: Date): Promise<void>
  /**
   * Claims one reminder (an occurrence of an event, for one person) before it
   * is sent: true for the first claim, false when it was claimed already — so
   * no reminder goes out twice, whichever process ticks.
   */
  claimReminder(key: ReminderKey, at: Date): Promise<boolean>
  /** Gives a claim back (its push failed: the next tick tries again). */
  releaseReminder(key: ReminderKey): Promise<void>
  /** Forgets claims for occurrences that started before `before`; returns how many. */
  pruneReminders(before: Date): Promise<number>
}

/** One reminder: an event's occurrence (its start) for one member. */
export type ReminderKey = { eventId: string; occurrenceStart: Date; memberId: string }
