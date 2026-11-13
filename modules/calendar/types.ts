/**
 * Calendar values and the shapes the pages and tools read (pure; shared by
 * server and browser). plan/calendar.md §2: per event, colleagues see the
 * title + time (company), "Busy" + time (busy) or "Out of office" + time
 * (private). New events default to busy.
 */

export const VISIBILITIES = ['company', 'busy', 'private'] as const
export type Visibility = (typeof VISIBILITIES)[number]

export const DEFAULT_VISIBILITY: Visibility = 'busy'

export const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

export const EVENT_SOURCES = ['local', 'google', 'microsoft', 'email_proposal'] as const
export type EventSource = (typeof EVENT_SOURCES)[number]

export const ATTENDEE_ROLES = ['required', 'optional'] as const
export type AttendeeRole = (typeof ATTENDEE_ROLES)[number]

export const RSVPS = ['needs_action', 'accepted', 'declined', 'tentative'] as const
export type Rsvp = (typeof RSVPS)[number]

export const CALENDAR_LIMITS = {
  title: 300,
  notes: 5000,
  location: 300,
  attendees: 100,
  attendeeName: 200,
  email: 320,
  /** The longest range one read covers (a month view shows six weeks). */
  rangeDays: 62,
  /** The most colleagues one availability read covers. */
  freeBusyMembers: 50,
} as const

/** What a colleague sees instead of the title. */
export const LIMITED_TITLE = { busy: 'Busy', private: 'Out of office' } as const satisfies Record<Exclude<Visibility, 'company'>, string>

/** The visibility choices as the dialog explains them. */
export const VISIBILITY_COPY: Record<Visibility, { label: string; colleagues: string }> = {
  company: { label: 'Visible to the company', colleagues: 'Colleagues see the title and time.' },
  busy: { label: 'Busy', colleagues: 'Colleagues see “Busy” and the time.' },
  private: { label: 'Private', colleagues: 'Colleagues see “Out of office” and the time.' },
}

export type AttendeeDto = {
  memberId: string | null
  email: string | null
  /** A member's name, an external guest's name, or their address. */
  name: string
  role: AttendeeRole
  rsvp: Rsvp
}

/** One event (a single event, a series, or one changed instance of a series) as its owner and guests see it. */
export type EventDto = {
  id: string
  ownerId: string
  ownerName: string
  title: string
  notes: string | null
  location: string | null
  /** UTC instants (an all-day event: midnight to midnight after its last day, in timeZone). */
  start: string
  end: string
  allDay: boolean
  timeZone: string
  /** Wall times in timeZone (`YYYY-MM-DDTHH:mm`), or days with an inclusive end for an all-day event. */
  localStart: string
  localEnd: string
  visibility: Visibility
  status: EventStatus
  /** The series' rule; null for a single event and for a changed instance. */
  rrule: string | null
  /** A changed instance: its series and the instance start it replaces. */
  seriesId: string | null
  originalStart: string | null
  attendees: AttendeeDto[]
  callId: string | null
  source: EventSource
  /** Only the owner (or the agent working for them) changes or deletes it. */
  canEdit: boolean
}

/**
 * One occurrence on a calendar. The owner and member guests see it in full
 * (`event` set); everyone else sees the title (company) or "Busy" / "Out of
 * office" and the time, and nothing else (`event` null).
 */
export type OccurrenceDto = {
  key: string
  start: string
  end: string
  allDay: boolean
  ownerId: string
  ownerName: string
  view: 'full' | Visibility
  title: string
  status: EventStatus
  /** A recurring instance: its start within the series (to change or delete just this one). */
  occurrenceStart: string | null
  event: EventDto | null
}

/** A colleague's time as availability shows it: busy or out of office, with the title only for a company-visible event. */
export type BusyBlockDto = {
  start: string
  end: string
  allDay: boolean
  kind: 'busy' | 'out_of_office'
  title: string | null
}

export type FreeBusyDto = { memberId: string; name: string; blocks: BusyBlockDto[] }

export type MemberOption = { id: string; name: string }
