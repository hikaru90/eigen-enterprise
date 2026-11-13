import { describe, expect, it } from 'vitest'
import {
  createEvent,
  defaultVisibility,
  deleteEvent,
  freeBusy,
  getEvent,
  listCalendar,
  setDefaultVisibility,
  updateEvent,
} from './service'
import { agent, fixture, timed, user } from './test-fixtures'

const range = (from: string, to: string) => ({ from, to })
const NOV = range('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z')

describe('creating an event', () => {
  it('lands on the person’s own calendar, busy by default, stored in UTC with the zone it was made in', async () => {
    const { deps, events } = fixture()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00', { location: 'Room 2' }))
    expect(e).toMatchObject({
      ownerId: 'ana',
      ownerName: 'Ana Lind',
      title: 'Planning',
      start: '2026-11-16T09:00:00.000Z',
      end: '2026-11-16T10:00:00.000Z',
      timeZone: 'Europe/Berlin',
      localStart: '2026-11-16T10:00',
      localEnd: '2026-11-16T11:00',
      allDay: false,
      visibility: 'busy',
      status: 'confirmed',
      source: 'local',
      location: 'Room 2',
      canEdit: true,
    })
    // The audit trail carries ids, never the title or the guests.
    expect(events).toEqual([{ type: 'calendar.event_created', principalId: 'ana', payload: { id: e.id, recurring: false, guests: 0 } }])
  })

  it('a member’s own default visibility applies to new events; an explicit choice wins', async () => {
    const { deps } = fixture()
    expect(await defaultVisibility(deps, user('ana'))).toBe('busy')
    await setDefaultVisibility(deps, user('ana'), 'private')
    expect(await defaultVisibility(deps, user('ana'))).toBe('private')
    expect((await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00'))).visibility).toBe('private')
    expect((await createEvent(deps, user('ana'), timed('2026-11-16', '12:00', '13:00', { visibility: 'company' }))).visibility).toBe('company')
    await expect(setDefaultVisibility(deps, user('ana'), 'secret')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('all-day events cover whole days in their zone (the end day is inclusive)', async () => {
    const { deps } = fixture()
    const e = await createEvent(deps, user('ana'), { title: 'Away', allDay: true, start: '2026-11-19', end: '2026-11-20', timeZone: 'Europe/Berlin' })
    expect(e).toMatchObject({
      start: '2026-11-18T23:00:00.000Z',
      end: '2026-11-20T23:00:00.000Z',
      localStart: '2026-11-19',
      localEnd: '2026-11-20',
      allDay: true,
    })
  })

  it.each([
    [{ title: '' }, 'title'],
    [{ title: 'x'.repeat(301) }, '300'],
    [{ start: '2026-11-16T11:00', end: '2026-11-16T10:00' }, 'end'],
    [{ start: '2026-11-16 10:00' }, 'YYYY-MM-DDTHH:mm'],
    [{ start: '2026-02-30T10:00' }, 'YYYY-MM-DDTHH:mm'],
    [{ timeZone: 'Mars/Olympus' }, 'time zone'],
    [{ timeZone: undefined }, 'time zone'],
    [{ visibility: 'secret' }, 'visibility'],
    [{ status: 'maybe' }, 'status'],
    [{ rrule: 'FREQ=HOURLY' }, 'FREQ'],
    [{ allDay: true, start: '2026-11-20', end: '2026-11-19' }, 'end'],
    [{ allDay: 'yes' }, 'allDay'],
  ])('refuses %j with a plain reason', async (over, reason) => {
    const { deps, store } = fixture()
    const attempt = createEvent(deps, user('ana'), { ...timed('2026-11-16', '10:00', '11:00'), ...over })
    await expect(attempt).rejects.toMatchObject({ code: 'invalid' })
    await expect(createEvent(deps, user('ana'), { ...timed('2026-11-16', '10:00', '11:00'), ...over })).rejects.toThrow(reason)
    expect(store.events.size).toBe(0)
  })

  it('takes members and people outside the company as guests (for invitations later), one entry each', async () => {
    const { deps } = fixture()
    const e = await createEvent(deps, user('ana'), {
      ...timed('2026-11-16', '10:00', '11:00'),
      attendees: [{ memberId: 'ben' }, { email: ' Mara@Northwind.example ', name: 'Mara Voss' }, { memberId: 'ben' }, { email: 'mara@northwind.example' }],
    })
    expect(e.attendees).toEqual([
      { memberId: 'ben', email: null, name: 'Ben Ode', role: 'required', rsvp: 'needs_action' },
      { memberId: null, email: 'mara@northwind.example', name: 'Mara Voss', role: 'required', rsvp: 'needs_action' },
    ])
  })

  it.each([
    [[{ memberId: 'zed' }], 'not in the company'],
    [[{ memberId: 'ana' }], 'own'],
    [[{ email: 'not-an-address' }], 'email'],
    [[{ email: 'a@b.example', memberId: 'ben' }], 'either'],
    [[{ memberId: 'ben', role: 'boss' }], 'role'],
    ['ben', 'list'],
  ])('refuses guests %j', async (attendees, reason) => {
    const { deps } = fixture()
    await expect(createEvent(deps, user('ana'), { ...timed('2026-11-16', '10:00', '11:00'), attendees })).rejects.toThrow(reason)
  })

  it('a later stream can file an event accepted from an email proposal (source email_proposal, external guest)', async () => {
    const { deps } = fixture()
    const e = await createEvent(
      deps,
      user('ana'),
      { ...timed('2026-11-17', '15:00', '15:30', { title: 'Call with Northwind' }), attendees: [{ email: 'mara@northwind.example' }] },
      { source: 'email_proposal', externalId: 'msg-123' },
    )
    expect(e).toMatchObject({ source: 'email_proposal', attendees: [{ email: 'mara@northwind.example', name: 'mara@northwind.example' }] })
  })

  it('only people in the company have a calendar; the agent on its own has none', async () => {
    const { deps } = fixture()
    await expect(createEvent(deps, user('stranger'), timed('2026-11-16', '10:00', '11:00'))).rejects.toMatchObject({ code: 'forbidden' })
    await expect(createEvent(deps, agent, timed('2026-11-16', '10:00', '11:00'))).rejects.toMatchObject({ code: 'forbidden' })
    await expect(listCalendar(deps, agent, NOV)).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('who sees what (plan/calendar.md §2)', () => {
  async function anasWeek() {
    const f = fixture()
    const company = await createEvent(f.deps, user('ana'), timed('2026-11-16', '09:00', '10:00', { title: 'Team sync', visibility: 'company' }))
    const busy = await createEvent(f.deps, user('ana'), timed('2026-11-16', '11:00', '12:00', { title: 'Call with investor', notes: 'deck v3' }))
    const priv = await createEvent(f.deps, user('ana'), timed('2026-11-16', '14:00', '15:00', { title: 'Doctor', visibility: 'private' }))
    return { ...f, company, busy, priv }
  }

  it('colleagues see the title + time of a company event, “Busy” + time of a busy one, “Out of office” + time of a private one — nothing more', async () => {
    const { deps } = await anasWeek()
    const [ana] = await freeBusy(deps, user('ben'), { memberIds: ['ana'], ...range('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z') })
    expect(ana).toEqual({
      memberId: 'ana',
      name: 'Ana Lind',
      blocks: [
        { start: '2026-11-16T08:00:00.000Z', end: '2026-11-16T09:00:00.000Z', allDay: false, kind: 'busy', title: 'Team sync' },
        { start: '2026-11-16T10:00:00.000Z', end: '2026-11-16T11:00:00.000Z', allDay: false, kind: 'busy', title: null },
        { start: '2026-11-16T13:00:00.000Z', end: '2026-11-16T14:00:00.000Z', allDay: false, kind: 'out_of_office', title: null },
      ],
    })
    expect(JSON.stringify(ana)).not.toMatch(/investor|Doctor|deck/)
  })

  it('the owner and admins get no extra view of anyone’s busy or private events', async () => {
    const { deps, priv } = await anasWeek()
    const asBen = await freeBusy(deps, user('ben'), { memberIds: ['ana'], ...NOV })
    expect(await freeBusy(deps, user('olga'), { memberIds: ['ana'], ...NOV })).toEqual(asBen)
    expect(await freeBusy(deps, user('adam'), { memberIds: ['ana'], ...NOV })).toEqual(asBen)
    await expect(getEvent(deps, user('olga'), priv.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('the agent on its own sees availability exactly like a colleague does', async () => {
    const { deps } = await anasWeek()
    expect(await freeBusy(deps, agent, { memberIds: ['ana'], ...NOV })).toEqual(await freeBusy(deps, user('ben'), { memberIds: ['ana'], ...NOV }))
  })

  it('the owner sees their own events in full; a colleague does not find them', async () => {
    const { deps, busy, priv } = await anasWeek()
    const mine = await listCalendar(deps, user('ana'), NOV)
    expect(mine.map((o) => [o.title, o.view, o.event?.canEdit])).toEqual([
      ['Team sync', 'full', true],
      ['Call with investor', 'full', true],
      ['Doctor', 'full', true],
    ])
    expect(mine[1].event).toMatchObject({ notes: 'deck v3' })
    expect(await listCalendar(deps, user('ben'), NOV)).toEqual([])
    await expect(getEvent(deps, user('ben'), busy.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(getEvent(deps, user('ben'), priv.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a member guest sees the event in full on their own calendar — and cannot change it', async () => {
    const { deps } = fixture()
    const e = await createEvent(deps, user('ana'), {
      ...timed('2026-11-16', '14:00', '15:00', { title: 'Offsite plan', visibility: 'private' }),
      attendees: [{ memberId: 'ben' }],
    })
    const bens = await listCalendar(deps, user('ben'), NOV)
    expect(bens.map((o) => [o.title, o.view, o.ownerName, o.event?.canEdit])).toEqual([['Offsite plan', 'full', 'Ana Lind', false]])
    await expect(updateEvent(deps, user('ben'), e.id, { title: 'Mine now' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(deleteEvent(deps, user('ben'), e.id)).rejects.toMatchObject({ code: 'forbidden' })
    // Ben's availability shows the time, labelled by the event's own visibility.
    const [ben] = await freeBusy(deps, user('olga'), { memberIds: ['ben'], ...NOV })
    expect(ben.blocks).toEqual([{ start: '2026-11-16T13:00:00.000Z', end: '2026-11-16T14:00:00.000Z', allDay: false, kind: 'out_of_office', title: null }])
  })

  it('cancelled events and invitations a guest declined take no time', async () => {
    const { deps, store } = fixture()
    await createEvent(deps, user('ana'), timed('2026-11-16', '09:00', '10:00', { status: 'cancelled' }))
    const e = await createEvent(deps, user('ana'), { ...timed('2026-11-16', '11:00', '12:00'), attendees: [{ memberId: 'ben' }] })
    for (const g of store.guests.values()) if (g.eventId === e.id) g.rsvp = 'declined'
    const [ana, ben] = await freeBusy(deps, user('olga'), { memberIds: ['ana', 'ben'], ...NOV })
    expect(ana.blocks.map((b) => b.start)).toEqual(['2026-11-16T10:00:00.000Z'])
    expect(ben.blocks).toEqual([])
  })

  it('availability asks are bounded and name people in the company', async () => {
    const { deps } = fixture()
    await expect(freeBusy(deps, user('ben'), { memberIds: ['zed'], ...NOV })).rejects.toMatchObject({ code: 'invalid' })
    await expect(freeBusy(deps, user('ben'), { memberIds: [], ...NOV })).rejects.toMatchObject({ code: 'invalid' })
    await expect(freeBusy(deps, user('ben'), { memberIds: ['ana'], ...range('2026-11-01T00:00:00Z', '2027-02-01T00:00:00Z') })).rejects.toThrow('62 days')
    await expect(listCalendar(deps, user('ben'), range('2026-11-02T00:00:00Z', '2026-11-01T00:00:00Z'))).rejects.toMatchObject({ code: 'invalid' })
    await expect(listCalendar(deps, user('ben'), range('yesterday', '2026-11-01T00:00:00Z'))).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('recurring events', () => {
  async function weekly() {
    const f = fixture()
    const series = await createEvent(f.deps, user('ana'), timed('2026-11-02', '10:00', '10:30', { title: 'Standup', rrule: 'FREQ=WEEKLY;BYDAY=MO' }))
    return { ...f, series }
  }
  const starts = (os: Array<{ start: string }>) => os.map((o) => o.start)

  it('expand on read: every Monday in the range, each pointing at its instance', async () => {
    const { deps, series } = await weekly()
    expect(series.rrule).toBe('FREQ=WEEKLY;BYDAY=MO')
    const list = await listCalendar(deps, user('ana'), NOV)
    expect(starts(list)).toEqual(['2026-11-02T09:00:00.000Z', '2026-11-09T09:00:00.000Z', '2026-11-16T09:00:00.000Z', '2026-11-23T09:00:00.000Z', '2026-11-30T09:00:00.000Z'])
    expect(list[1]).toMatchObject({ occurrenceStart: '2026-11-09T09:00:00.000Z', event: { id: series.id, rrule: 'FREQ=WEEKLY;BYDAY=MO' } })
    // Colleagues see each instance as busy time.
    const [ana] = await freeBusy(deps, user('ben'), { memberIds: ['ana'], ...range('2026-11-09T00:00:00Z', '2026-11-17T00:00:00Z') })
    expect(ana.blocks.map((b) => [b.start, b.kind])).toEqual([
      ['2026-11-09T09:00:00.000Z', 'busy'],
      ['2026-11-16T09:00:00.000Z', 'busy'],
    ])
  })

  it('changing just one instance keeps the others; moving it out of the range hides the original there', async () => {
    const { deps, series } = await weekly()
    const one = { occurrenceStart: '2026-11-09T09:00:00.000Z' }
    const changed = await updateEvent(deps, user('ana'), series.id, { ...timed('2026-11-10', '15:00', '15:30'), title: 'Standup (moved)' }, one)
    expect(changed).toMatchObject({ seriesId: series.id, originalStart: '2026-11-09T09:00:00.000Z', rrule: null, title: 'Standup (moved)' })
    const list = await listCalendar(deps, user('ana'), NOV)
    expect(list.map((o) => [o.start, o.title])).toEqual([
      ['2026-11-02T09:00:00.000Z', 'Standup'],
      ['2026-11-10T14:00:00.000Z', 'Standup (moved)'],
      ['2026-11-16T09:00:00.000Z', 'Standup'],
      ['2026-11-23T09:00:00.000Z', 'Standup'],
      ['2026-11-30T09:00:00.000Z', 'Standup'],
    ])
    // Changing the same instance again edits the change (one per instance).
    await updateEvent(deps, user('ana'), series.id, { title: 'Standup (moved again)' }, one)
    expect((await listCalendar(deps, user('ana'), NOV)).filter((o) => o.title.startsWith('Standup (')).map((o) => o.title)).toEqual(['Standup (moved again)'])
    // The original Monday is not shown in a range that holds only it.
    expect(await listCalendar(deps, user('ana'), range('2026-11-09T00:00:00Z', '2026-11-10T00:00:00Z'))).toEqual([])
    await expect(updateEvent(deps, user('ana'), series.id, { title: 'x' }, { occurrenceStart: '2026-11-11T09:00:00.000Z' })).rejects.toThrow('not an instance')
    await expect(updateEvent(deps, user('ana'), series.id, { attendees: [] }, one)).rejects.toThrow('all events')
  })

  it('deleting one instance leaves the rest; deleting the series removes every instance and change', async () => {
    const { deps, series, store } = await weekly()
    await updateEvent(deps, user('ana'), series.id, { title: 'Changed' }, { occurrenceStart: '2026-11-23T09:00:00.000Z' })
    await deleteEvent(deps, user('ana'), series.id, { occurrenceStart: '2026-11-16T09:00:00.000Z' })
    await deleteEvent(deps, user('ana'), series.id, { occurrenceStart: '2026-11-23T09:00:00.000Z' })
    expect(starts(await listCalendar(deps, user('ana'), NOV))).toEqual(['2026-11-02T09:00:00.000Z', '2026-11-09T09:00:00.000Z', '2026-11-30T09:00:00.000Z'])
    await deleteEvent(deps, user('ana'), series.id)
    expect(await listCalendar(deps, user('ana'), NOV)).toEqual([])
    expect(store.events.size).toBe(0)
  })

  it('a new time or rule for all events starts the series over (changes to single instances are dropped)', async () => {
    const { deps, series } = await weekly()
    await updateEvent(deps, user('ana'), series.id, { title: 'Changed' }, { occurrenceStart: '2026-11-16T09:00:00.000Z' })
    await deleteEvent(deps, user('ana'), series.id, { occurrenceStart: '2026-11-23T09:00:00.000Z' })
    await updateEvent(deps, user('ana'), series.id, { ...timed('2026-11-03', '09:00', '09:15', { title: 'Standup' }), rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=3' })
    expect((await listCalendar(deps, user('ana'), NOV)).map((o) => [o.start, o.title])).toEqual([
      ['2026-11-03T08:00:00.000Z', 'Standup'],
      ['2026-11-10T08:00:00.000Z', 'Standup'],
      ['2026-11-17T08:00:00.000Z', 'Standup'],
    ])
  })

  it('a title change for all events keeps the single changes', async () => {
    const { deps, series } = await weekly()
    await deleteEvent(deps, user('ana'), series.id, { occurrenceStart: '2026-11-16T09:00:00.000Z' })
    await updateEvent(deps, user('ana'), series.id, { title: 'Daily-ish' })
    expect((await listCalendar(deps, user('ana'), NOV)).map((o) => o.title)).toEqual(['Daily-ish', 'Daily-ish', 'Daily-ish', 'Daily-ish'])
  })

  it('a series that ended no longer shows up later', async () => {
    const { deps } = fixture()
    await createEvent(deps, user('ana'), timed('2026-11-02', '10:00', '10:30', { rrule: 'FREQ=DAILY;COUNT=2' }))
    expect(await listCalendar(deps, user('ana'), range('2026-11-04T00:00:00Z', '2026-11-30T00:00:00Z'))).toEqual([])
  })
})

describe('changing and deleting', () => {
  it('the owner changes only what is sent; clearing optional text with null or blank', async () => {
    const { deps, events } = fixture()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00', { location: 'Room 2', notes: 'bring the deck' }))
    const changed = await updateEvent(deps, user('ana'), e.id, { location: '', notes: null, visibility: 'private' })
    expect(changed).toMatchObject({ title: 'Planning', location: null, notes: null, visibility: 'private', start: e.start })
    expect(events.at(-1)).toEqual({ type: 'calendar.event_updated', principalId: 'ana', payload: { id: e.id, fields: ['notes', 'location', 'visibility'] } })
    await expect(updateEvent(deps, user('ana'), e.id, {})).rejects.toThrow('Nothing to change')
    await expect(updateEvent(deps, user('ana'), e.id, { start: '2026-11-16T12:00' })).rejects.toThrow('together')
  })

  it('someone who cannot see an event does not learn it exists', async () => {
    const { deps } = fixture()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00'))
    await expect(updateEvent(deps, user('olga'), e.id, { title: 'x' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(deleteEvent(deps, user('adam'), e.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(getEvent(deps, user('ana'), 'not-a-uuid')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a single event has no instances to change one by one', async () => {
    const { deps } = fixture()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00'))
    await expect(updateEvent(deps, user('ana'), e.id, { title: 'x' }, { occurrenceStart: e.start })).rejects.toThrow('not a recurring')
  })
})
