import type { CalendarCallsPort, CallBooking } from './event-calls'
import { describe, expect, it } from 'vitest'
import { CalendarError } from './errors'
import { addCall, createEventWithCall, removeCall } from './event-calls'
import { createEvent, deleteEvent, getEvent, listCalendar, updateEvent } from './service'
import { agent, fixture, timed, user } from './test-fixtures'

/** Calls as the calendar reaches them: books meetings, knows which calls a person is in. */
function fakeCalls(opts: { refuse?: string } = {}) {
  const booked: Array<CallBooking & { userId: string }> = []
  const joinable = new Map<string, Set<string>>([['call-of-ben', new Set(['ben', 'ana'])]])
  const port: CalendarCallsPort = {
    async book(userId, input) {
      if (opts.refuse) throw new CalendarError('invalid', opts.refuse)
      booked.push({ userId, ...input })
      const callId = `call-${booked.length}`
      joinable.set(callId, new Set([userId, ...input.memberIds]))
      return { callId, invited: input.guests.length }
    },
    async canJoin(userId, callId) {
      return joinable.get(callId)?.has(userId) ?? false
    },
  }
  return { port, booked }
}

function setup(opts: { refuse?: string } = {}) {
  const f = fixture()
  const calls = fakeCalls(opts)
  f.deps.calls = calls.port
  return { ...f, ...calls }
}

describe('a call on an event', () => {
  it('Add a call books a meeting for the event’s time with its guests: colleagues join, people outside get the link', async () => {
    const { deps, booked, events } = setup()
    const e = await createEvent(
      deps,
      user('ana'),
      timed('2026-11-16', '10:00', '10:45', { title: 'Customer call', attendees: [{ memberId: 'ben' }, { email: 'mara@client.example', name: 'Mara' }] }),
    )
    const withCall = await addCall(deps, user('ana'), e.id, {})
    expect(booked).toEqual([
      {
        userId: 'ana',
        title: 'Customer call',
        startsAt: new Date('2026-11-16T09:00:00Z'),
        durationMinutes: 45,
        memberIds: ['ben'],
        guests: ['mara@client.example'],
        timeZone: 'Europe/Berlin',
        externalUrl: null,
      },
    ])
    expect(withCall).toMatchObject({ callId: 'call-1', joinUrl: '/calls/call-1' })
    // Guests see the call too, and join from the event.
    expect((await getEvent(deps, user('ben'), e.id)).joinUrl).toBe('/calls/call-1')
    expect(events.at(-1)).toEqual({ type: 'calendar.call_added', principalId: 'ana', payload: { id: e.id, booked: true, invited: 1 } })
  })

  it('takes another provider’s link (Zoom, Teams …) as the call', async () => {
    const { deps, booked } = setup()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00', { attendees: [{ memberId: 'ben' }] }))
    await addCall(deps, user('ana'), e.id, { externalUrl: 'https://zoom.example/j/1' })
    expect(booked[0]).toMatchObject({ externalUrl: 'https://zoom.example/j/1', durationMinutes: 60 })
  })

  it('links a call the person is already in instead of booking one', async () => {
    const { deps, booked, events } = setup()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00'))
    expect((await addCall(deps, user('ana'), e.id, { callId: 'call-of-ben' })).callId).toBe('call-of-ben')
    expect(booked).toEqual([])
    expect(events.at(-1)?.payload).toEqual({ id: e.id, booked: false, invited: 0 })
    const other = await createEvent(deps, user('ana'), timed('2026-11-17', '10:00', '11:00'))
    await expect(addCall(deps, user('ana'), other.id, { callId: 'someone-elses' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('only the owner adds one, to a timed event that does not repeat and has none yet', async () => {
    const { deps } = setup()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00', { attendees: [{ memberId: 'ben' }] }))
    await expect(addCall(deps, user('ben'), e.id, {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(addCall(deps, agent, e.id, {})).rejects.toMatchObject({ code: 'not_found' })
    await addCall(deps, user('ana'), e.id, {})
    await expect(addCall(deps, user('ana'), e.id, {})).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/already has a call/) })
    const allDay = await createEvent(deps, user('ana'), { title: 'Offsite', allDay: true, start: '2026-11-18', end: '2026-11-18', timeZone: 'Europe/Berlin', attendees: [{ memberId: 'ben' }] })
    await expect(addCall(deps, user('ana'), allDay.id, {})).rejects.toMatchObject({ code: 'invalid' })
    const series = await createEvent(deps, user('ana'), timed('2026-11-16', '12:00', '13:00', { rrule: 'FREQ=WEEKLY', attendees: [{ memberId: 'ben' }] }))
    await expect(addCall(deps, user('ana'), series.id, {})).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/repeating/) })
  })

  it('a booked call needs someone to call', async () => {
    const { deps, booked } = setup()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00'))
    await expect(addCall(deps, user('ana'), e.id, {})).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/guest/) })
    expect(booked).toEqual([])
  })

  it('fails loud without Calls wired', async () => {
    const { deps } = fixture()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00', { attendees: [{ memberId: 'ben' }] }))
    await expect(addCall(deps, user('ana'), e.id, {})).rejects.toThrow(/Calls/)
  })

  it('Remove call takes it off the event (the meeting itself stays booked)', async () => {
    const { deps, events } = setup()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00', { attendees: [{ memberId: 'ben' }] }))
    await addCall(deps, user('ana'), e.id, {})
    await expect(removeCall(deps, user('ben'), e.id)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await removeCall(deps, user('ana'), e.id)).toMatchObject({ callId: null, joinUrl: null })
    expect(events.at(-1)).toEqual({ type: 'calendar.call_removed', principalId: 'ana', payload: { id: e.id } })
    await expect(removeCall(deps, user('ana'), e.id)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('an event with a call keeps its time: moving it asks to remove the call first; other changes are fine', async () => {
    const { deps } = setup()
    const e = await createEvent(deps, user('ana'), timed('2026-11-16', '10:00', '11:00', { attendees: [{ memberId: 'ben' }] }))
    await addCall(deps, user('ana'), e.id, {})
    const same = { allDay: false, start: '2026-11-16T10:00', end: '2026-11-16T11:00', timeZone: 'Europe/Berlin' }
    // The dialog always sends the time: unchanged, it saves.
    expect((await updateEvent(deps, user('ana'), e.id, { ...same, title: 'Renamed' })).callId).toBe('call-1')
    await expect(updateEvent(deps, user('ana'), e.id, { ...same, start: '2026-11-16T12:00', end: '2026-11-16T13:00' })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/remove the call/i),
    })
    await expect(updateEvent(deps, user('ana'), e.id, { rrule: 'FREQ=WEEKLY' })).rejects.toMatchObject({ code: 'invalid' })
    // Deleting the event takes the call link with it.
    await deleteEvent(deps, user('ana'), e.id)
  })

  it('a new event with a call: made and booked together, or not at all', async () => {
    const { deps } = setup()
    const input = timed('2026-11-16', '10:00', '11:00', { attendees: [{ memberId: 'ben' }] })
    expect((await createEventWithCall(deps, user('ana'), input, {})).joinUrl).toBe('/calls/call-1')

    const refused = setup({ refuse: 'Calls are not set up on this server' })
    await expect(createEventWithCall(refused.deps, user('ana'), input, {})).rejects.toThrow(/not set up/)
    const nov = { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }
    expect(await listCalendar(refused.deps, user('ana'), nov)).toEqual([])
    expect(refused.events.map((e) => e.type)).toEqual(['calendar.event_created', 'calendar.event_deleted'])
  })
})
