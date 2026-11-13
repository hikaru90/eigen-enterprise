import type { OccurrenceDto, ProposalDto } from './types'
import { describe, expect, it } from 'vitest'
import { editDraft, eventFormInput, newDraft, proposalDraft, repeatFromRrule, repeatToRrule, type RepeatForm } from './form'

const fd = (entries: Array<[string, string]>) => {
  const f = new FormData()
  for (const [k, v] of entries) f.append(k, v)
  return f
}

const none: RepeatForm = { freq: 'none', interval: 1, days: [], end: 'never', until: '', count: 10, custom: null }

describe('repeat ↔ RRULE', () => {
  it.each([
    [{ ...none }, null],
    [{ ...none, freq: 'DAILY' }, 'FREQ=DAILY'],
    [{ ...none, freq: 'WEEKLY', days: ['MO', 'TH'], interval: 2 }, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH'],
    [{ ...none, freq: 'MONTHLY', end: 'after', count: 6 }, 'FREQ=MONTHLY;COUNT=6'],
    [{ ...none, freq: 'YEARLY', end: 'on', until: '2030-12-31' }, 'FREQ=YEARLY;UNTIL=20301231'],
  ] as const)('%j → %s', (form, rrule) => {
    expect(repeatToRrule(form as RepeatForm)).toBe(rrule)
    if (rrule) expect(repeatFromRrule(rrule)).toEqual({ ...none, ...form, days: [...form.days] })
  })

  it('a rule the dialog does not build (from a synced calendar) is kept as it is', () => {
    const form = repeatFromRrule('FREQ=MONTHLY;BYDAY=-1FR')
    expect(form).toMatchObject({ freq: 'MONTHLY', custom: 'FREQ=MONTHLY;BYDAY=-1FR' })
    expect(repeatToRrule(form)).toBe('FREQ=MONTHLY;BYDAY=-1FR')
  })

  it('“after 0 times” or “until” without a day is refused, not guessed', () => {
    expect(() => repeatToRrule({ ...none, freq: 'DAILY', end: 'on', until: '' })).toThrow('day')
    expect(() => repeatToRrule({ ...none, freq: 'DAILY', end: 'after', count: 0 })).toThrow('times')
  })
})

describe('eventFormInput', () => {
  const base: Array<[string, string]> = [
    ['title', ' Planning '],
    ['startDay', '2026-11-16'],
    ['startTime', '10:00'],
    ['endDay', '2026-11-16'],
    ['endTime', '11:00'],
    ['timeZone', 'Europe/Berlin'],
    ['location', 'Room 2'],
    ['notes', ''],
    ['visibility', 'private'],
    ['repeat', 'WEEKLY'],
    ['repeatInterval', '1'],
    ['repeatDay', 'MO'],
    ['repeatEnd', 'never'],
    ['guest', 'ben'],
    ['guestEmail', 'mara@northwind.example'],
    ['guestEmailName', 'Mara Voss'],
  ]

  it('a new timed event: wall times, its zone, the rule and the guests', () => {
    expect(eventFormInput(fd(base))).toEqual({
      id: null,
      occurrenceStart: null,
      proposalId: null,
      input: {
        title: ' Planning ',
        allDay: false,
        start: '2026-11-16T10:00',
        end: '2026-11-16T11:00',
        timeZone: 'Europe/Berlin',
        location: 'Room 2',
        notes: '',
        visibility: 'private',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        attendees: [{ memberId: 'ben' }, { email: 'mara@northwind.example', name: 'Mara Voss' }],
      },
    })
  })

  it('an all-day event sends days', () => {
    const out = eventFormInput(fd([...base, ['allDay', 'on'], ['id', 'e1']]))
    expect(out.id).toBe('e1')
    expect(out.input).toMatchObject({ allDay: true, start: '2026-11-16', end: '2026-11-16' })
  })

  it('“this event” of a series sends neither the rule nor the guests', () => {
    const out = eventFormInput(fd([...base, ['id', 's1'], ['scope', 'one'], ['occurrenceStart', '2026-11-16T09:00:00.000Z']]))
    expect(out.occurrenceStart).toBe('2026-11-16T09:00:00.000Z')
    expect(out.input).not.toHaveProperty('rrule')
    expect(out.input).not.toHaveProperty('attendees')
  })
})

describe('drafts for the dialog', () => {
  it('a new event starts at the slot (or 09:00) for an hour, in the viewer’s zone, with their default visibility', () => {
    expect(newDraft({ day: '2026-11-16', time: '14:00', timeZone: 'Europe/Berlin', visibility: 'busy' })).toMatchObject({
      id: null,
      title: '',
      allDay: false,
      startDay: '2026-11-16',
      startTime: '14:00',
      endDay: '2026-11-16',
      endTime: '15:00',
      timeZone: 'Europe/Berlin',
      visibility: 'busy',
      repeat: { freq: 'none' },
    })
    expect(newDraft({ day: '2026-11-16', time: null, timeZone: 'UTC', visibility: 'private' })).toMatchObject({ startTime: '09:00', endTime: '10:00' })
    expect(newDraft({ day: '2026-11-16', time: '23:30', timeZone: 'UTC', visibility: 'busy' })).toMatchObject({ endDay: '2026-11-17', endTime: '00:30' })
  })

  it('an instance of a series offers this one (its own time) or all of them (the series’ time)', () => {
    const occ = {
      key: 'k',
      start: '2026-11-16T09:00:00.000Z',
      end: '2026-11-16T09:30:00.000Z',
      allDay: false,
      ownerId: 'ana',
      ownerName: 'Ana Lind',
      view: 'full',
      title: 'Standup',
      status: 'confirmed',
      occurrenceStart: '2026-11-16T09:00:00.000Z',
      event: {
        id: 's1',
        ownerId: 'ana',
        ownerName: 'Ana Lind',
        title: 'Standup',
        notes: null,
        location: null,
        start: '2026-11-02T09:00:00.000Z',
        end: '2026-11-02T09:30:00.000Z',
        allDay: false,
        timeZone: 'Europe/Berlin',
        localStart: '2026-11-02T10:00',
        localEnd: '2026-11-02T10:30',
        visibility: 'company',
        status: 'confirmed',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        seriesId: null,
        originalStart: null,
        attendees: [
          { memberId: 'ben', email: null, name: 'Ben Ode', role: 'required', rsvp: 'needs_action' },
          { memberId: null, email: 'mara@northwind.example', name: 'Mara Voss', role: 'required', rsvp: 'needs_action' },
        ],
        callId: null,
        source: 'local',
        canEdit: true,
      },
    } satisfies OccurrenceDto
    const d = editDraft(occ)
    expect(d).toMatchObject({
      id: 's1',
      occurrenceStart: '2026-11-16T09:00:00.000Z',
      inSeries: true,
      startDay: '2026-11-16',
      startTime: '10:00',
      series: { startDay: '2026-11-02', startTime: '10:00', endDay: '2026-11-02', endTime: '10:30' },
      visibility: 'company',
      repeat: { freq: 'WEEKLY', days: ['MO'] },
      guests: ['ben'],
      guestLabels: ['Ben Ode', 'Mara Voss'],
      externalGuests: [{ email: 'mara@northwind.example', name: 'Mara Voss' }],
    })
  })
})

describe('the dialog for an appointment found in mail (K7 Edit)', () => {
  const proposal: ProposalDto = {
    id: 'p-1',
    state: 'open',
    title: 'Call with Mara Voss',
    start: '2026-11-19T14:00:00.000Z',
    end: '2026-11-19T14:30:00.000Z',
    timeZone: 'Europe/Berlin',
    localStart: '2026-11-19T15:00',
    localEnd: '2026-11-19T15:30',
    location: null,
    call: 'https://meet.example/abc',
    attendees: [{ email: 'mara@sender.example', name: 'Mara Voss' }],
    eventId: null,
    mail: { messageId: 'm-1', mailboxId: 'b-1', subject: 'Re: Call?', from: { name: 'Mara Voss', address: 'mara@sender.example' } },
  }

  it('starts as Accept would create it: the time in its zone, the link as the place, the people from the mail as guests', () => {
    expect(proposalDraft(proposal, 'busy')).toMatchObject({
      id: null,
      proposalId: 'p-1',
      title: 'Call with Mara Voss',
      startDay: '2026-11-19',
      startTime: '15:00',
      endDay: '2026-11-19',
      endTime: '15:30',
      timeZone: 'Europe/Berlin',
      location: 'https://meet.example/abc',
      notes: '',
      visibility: 'busy',
      externalGuests: [{ email: 'mara@sender.example', name: 'Mara Voss' }],
    })
  })

  it('with a place too, the link goes in the notes', () => {
    expect(proposalDraft({ ...proposal, location: 'Café Einstein' }, 'company')).toMatchObject({ location: 'Café Einstein', notes: 'https://meet.example/abc' })
  })

  it('the posted form carries the proposal it accepts', () => {
    const form = new FormData()
    form.set('proposalId', 'p-1')
    form.set('title', 'x')
    expect(eventFormInput(form).proposalId).toBe('p-1')
    expect(eventFormInput(new FormData()).proposalId).toBeNull()
  })
})
