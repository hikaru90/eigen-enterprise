import { describe, expect, it } from 'vitest'
import { invitationIcs, type InvitationEvent } from './ics'

const event: InvitationEvent = {
  uid: '00000000-0000-4000-8000-000000000001@example.com',
  stamp: new Date('2026-11-12T09:00:00Z'),
  start: new Date('2026-11-19T14:00:00Z'),
  end: new Date('2026-11-19T14:30:00Z'),
  summary: 'Call: Q4 plan, with Mara',
  description: 'Agreed by mail.\nJoin: https://meet.example/abc; dial 0800',
  location: 'Video call',
  organizer: { name: 'Ana Lind', address: 'ana.lind@example.com' },
  attendees: [
    { name: 'Mara Voss', address: 'mara@sender.example' },
    { name: null, address: 'sam@sender.example' },
  ],
}

/** Unfolds RFC 5545 content lines (CRLF + one space continues the line). */
const unfold = (ics: string) => ics.replace(/\r\n /g, '')

describe('the iMIP invitation (RFC 5545 / 5546 REQUEST)', () => {
  it('is a VCALENDAR with METHOD:REQUEST and one VEVENT carrying UID, DTSTAMP, times, ORGANIZER and ATTENDEEs', () => {
    const ics = invitationIcs(event)
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    const lines = unfold(ics).split('\r\n')
    expect(lines).toEqual(
      expect.arrayContaining([
        'VERSION:2.0',
        'PRODID:-//eigenEnterprise//Calendar//EN',
        'METHOD:REQUEST',
        'CALSCALE:GREGORIAN',
        'BEGIN:VEVENT',
        'UID:00000000-0000-4000-8000-000000000001@example.com',
        'DTSTAMP:20261112T090000Z',
        'DTSTART:20261119T140000Z',
        'DTEND:20261119T143000Z',
        'SEQUENCE:0',
        'STATUS:CONFIRMED',
        'SUMMARY:Call: Q4 plan\\, with Mara',
        'DESCRIPTION:Agreed by mail.\\nJoin: https://meet.example/abc\\; dial 0800',
        'LOCATION:Video call',
        'ORGANIZER;CN=Ana Lind:mailto:ana.lind@example.com',
        'ATTENDEE;CN=Mara Voss;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:mara@sender.example',
        'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:sam@sender.example',
        'END:VEVENT',
      ]),
    )
    expect(lines.indexOf('BEGIN:VEVENT')).toBeLessThan(lines.indexOf('END:VEVENT'))
  })

  it('folds every line to at most 75 octets (UTF-8), never inside a character', () => {
    const ics = invitationIcs({ ...event, summary: `Abstimmung zur Größenordnung ${'ü'.repeat(60)}`, description: 'x'.repeat(400) })
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
    expect(unfold(ics)).toContain(`SUMMARY:Abstimmung zur Größenordnung ${'ü'.repeat(60)}`)
    expect(unfold(ics)).toContain(`DESCRIPTION:${'x'.repeat(400)}`)
  })

  it('quotes a CN with characters a parameter can’t carry bare, and drops quotes it can’t carry at all', () => {
    const ics = unfold(invitationIcs({ ...event, organizer: { name: 'Lind, Ana "AL"', address: 'ana.lind@example.com' } }))
    expect(ics).toContain('ORGANIZER;CN="Lind, Ana AL":mailto:ana.lind@example.com')
  })

  it('leaves out an empty description and location', () => {
    const ics = invitationIcs({ ...event, description: null, location: null })
    expect(ics).not.toContain('DESCRIPTION')
    expect(ics).not.toContain('LOCATION')
  })

  it('refuses an event without guests or with an end before its start (fail loud)', () => {
    expect(() => invitationIcs({ ...event, attendees: [] })).toThrow(/guest/)
    expect(() => invitationIcs({ ...event, end: event.start })).toThrow(/end/)
  })
})
