/**
 * The iCalendar invitation (plan/calendar.md §5, K4): an iMIP REQUEST
 * (RFC 5545 + RFC 5546 + RFC 6047) for guests outside the company. Times are
 * UTC (`…Z`), so no VTIMEZONE is needed and every client shows them in its
 * own zone. Pure.
 */

export type InvitationPerson = { name: string | null; address: string }

export type InvitationEvent = {
  /** Globally unique and stable for the event (`<event id>@<sender domain>`). */
  uid: string
  stamp: Date
  start: Date
  end: Date
  summary: string
  description: string | null
  location: string | null
  organizer: InvitationPerson
  attendees: InvitationPerson[]
}

const CRLF = '\r\n'

/** `20261119T140000Z` */
function utc(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new Error('invitation: not a time')
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** TEXT value escaping (RFC 5545 §3.3.11). */
function text(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n?|\n/g, '\\n')
}

/** A parameter value (RFC 5545 §3.2): quoted when it holds `:;,`; DQUOTE and controls can't be carried and are dropped. */
function param(value: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/["\u0000-\u001f\u007f]/g, '').trim()
  return /[:;,]/.test(clean) ? `"${clean}"` : clean
}

const cn = (p: InvitationPerson) => (p.name && param(p.name) !== '' ? `;CN=${param(p.name)}` : '')
const mailto = (address: string) => `mailto:${address.trim().toLowerCase()}`

/** Folds a content line at 75 octets (RFC 5545 §3.1), between characters. */
function fold(line: string): string {
  const out: string[] = []
  let current = ''
  let bytes = 0
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8')
    // The first line holds 75 octets; continuation lines start with a space, so 74 more.
    const limit = out.length === 0 ? 75 : 74
    if (bytes + size > limit) {
      out.push(current)
      current = ''
      bytes = 0
    }
    current += ch
    bytes += size
  }
  out.push(current)
  return out.join(`${CRLF} `)
}

export function invitationIcs(e: InvitationEvent): string {
  if (e.attendees.length === 0) throw new Error('invitation: an invitation needs at least one guest')
  if (e.end.getTime() <= e.start.getTime()) throw new Error('invitation: the end must be after the start')
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//eigenEnterprise//Calendar//EN',
    'METHOD:REQUEST',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${utc(e.stamp)}`,
    `DTSTART:${utc(e.start)}`,
    `DTEND:${utc(e.end)}`,
    'SEQUENCE:0',
    'STATUS:CONFIRMED',
    `SUMMARY:${text(e.summary)}`,
    ...(e.description ? [`DESCRIPTION:${text(e.description)}`] : []),
    ...(e.location ? [`LOCATION:${text(e.location)}`] : []),
    `ORGANIZER${cn(e.organizer)}:${mailto(e.organizer.address)}`,
    ...e.attendees.map((a) => `ATTENDEE${cn(a)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:${mailto(a.address)}`),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(fold).join(CRLF) + CRLF
}
