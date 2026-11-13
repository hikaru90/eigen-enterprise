import type { AttendeeRow, EventRow } from './store'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbCalendarStore } from './db-store'
import { createEvent, deleteEvent, freeBusy, listCalendar, updateEvent, type CalendarDeps } from './service'

/**
 * The DB store against real Postgres (the test DB, :5433). Needs DATABASE_URL
 * with migrations applied (0138); skipped without it. Member ids carry a
 * per-run tag so parallel runs never see each other's events.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('calendar store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const run = `pg-spec-${randomUUID()}`
  const ana = `${run}-ana`
  const ben = `${run}-ben`

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    await sql`delete from calendar_events where owner_id in (${ana}, ${ben})`
    await sql`delete from calendar_preferences where member_id in (${ana}, ${ben})`
    await sql.end()
  })

  const deps = (): CalendarDeps => ({
    store: dbCalendarStore(db),
    members: async () => [
      { id: ana, name: 'Ana Lind', email: 'ana@example.com' },
      { id: ben, name: 'Ben Ode', email: 'ben@example.com' },
    ],
    roleOf: async (id) => (id === ana || id === ben ? 'member' : null),
    audit: async () => {},
  })
  const asAna = { kind: 'user' as const, userId: ana }
  const asBen = { kind: 'user' as const, userId: ben }
  const NOV = { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }

  const row = (over: Partial<EventRow> = {}): EventRow => {
    const at = new Date()
    return {
      id: randomUUID(),
      ownerId: ana,
      title: 'Planning',
      notes: null,
      startsAt: new Date('2026-11-16T09:00:00Z'),
      endsAt: new Date('2026-11-16T10:00:00Z'),
      timeZone: 'Europe/Berlin',
      allDay: false,
      location: null,
      callId: null,
      visibility: 'busy',
      status: 'confirmed',
      source: 'local',
      externalId: null,
      etag: null,
      rrule: null,
      exdates: [],
      recurrenceEndsAt: null,
      recurrenceId: null,
      originalStart: null,
      createdBy: ana,
      createdAt: at,
      updatedAt: at,
      ...over,
    }
  }

  it('round-trips an event with guests and exdates; deleting it deletes them', async () => {
    const store = dbCalendarStore(db)
    const e = row({ rrule: 'FREQ=DAILY', exdates: [new Date('2026-11-17T09:00:00Z')] })
    const guest: AttendeeRow = {
      id: randomUUID(),
      eventId: e.id,
      memberId: null,
      email: 'mara@northwind.example',
      name: 'Mara',
      role: 'required',
      rsvp: 'needs_action',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    await store.insertEvent(e, [guest])
    const back = await store.getEvent(e.id)
    expect(back?.exdates.map((d) => d.toISOString())).toEqual(['2026-11-17T09:00:00.000Z'])
    expect(back?.startsAt.toISOString()).toBe('2026-11-16T09:00:00.000Z')
    expect(await store.attendees([e.id])).toMatchObject([{ email: 'mara@northwind.example', rsvp: 'needs_action' }])
    await store.deleteEvent(e.id)
    expect(await store.getEvent(e.id)).toBeNull()
    expect(await store.attendees([e.id])).toEqual([])
  })

  it('the database refuses what the service never writes', async () => {
    const store = dbCalendarStore(db)
    await expect(store.insertEvent(row({ visibility: 'secret' as never }), [])).rejects.toThrow()
    await expect(store.insertEvent(row({ endsAt: new Date('2026-11-16T08:00:00Z') }), [])).rejects.toThrow()
    await expect(store.insertEvent(row({ recurrenceId: randomUUID() }), [])).rejects.toThrow()
  })

  it('the service flows run the same over Postgres: guests, series, one changed instance, availability', async () => {
    const d = deps()
    const meeting = await createEvent(d, asAna, {
      title: 'Offsite plan',
      allDay: false,
      start: '2026-11-18T14:00',
      end: '2026-11-18T15:00',
      timeZone: 'Europe/Berlin',
      visibility: 'private',
      attendees: [{ memberId: ben }, { email: 'mara@northwind.example' }],
    })
    const series = await createEvent(d, asAna, {
      title: 'Standup',
      allDay: false,
      start: '2026-11-02T10:00',
      end: '2026-11-02T10:30',
      timeZone: 'Europe/Berlin',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
    })
    await updateEvent(d, asAna, series.id, { title: 'Standup (moved)', allDay: false, start: '2026-11-10T15:00', end: '2026-11-10T15:30', timeZone: 'Europe/Berlin' }, {
      occurrenceStart: '2026-11-09T09:00:00.000Z',
    })
    await deleteEvent(d, asAna, series.id, { occurrenceStart: '2026-11-16T09:00:00.000Z' })

    expect((await listCalendar(d, asAna, NOV)).map((o) => [o.start, o.title])).toEqual([
      ['2026-11-02T09:00:00.000Z', 'Standup'],
      ['2026-11-10T14:00:00.000Z', 'Standup (moved)'],
      ['2026-11-18T13:00:00.000Z', 'Offsite plan'],
      ['2026-11-23T09:00:00.000Z', 'Standup'],
      ['2026-11-30T09:00:00.000Z', 'Standup'],
    ])
    // Ben is a guest: the private event is on his calendar in full.
    expect((await listCalendar(d, asBen, NOV)).map((o) => [o.title, o.event?.id, o.event?.canEdit])).toEqual([['Offsite plan', meeting.id, false]])
    // A range holding only the moved instance's original Monday is empty for Ana.
    expect(await listCalendar(d, asAna, { from: '2026-11-09T00:00:00Z', to: '2026-11-10T00:00:00Z' })).toEqual([])
    const [a, b] = await freeBusy(d, asBen, { memberIds: [ana, ben], from: '2026-11-18T00:00:00Z', to: '2026-11-19T00:00:00Z' })
    expect(a.blocks).toEqual([{ start: '2026-11-18T13:00:00.000Z', end: '2026-11-18T14:00:00.000Z', allDay: false, kind: 'out_of_office', title: null }])
    expect(b.blocks).toEqual(a.blocks)
  })

  it('keeps one default visibility per member', async () => {
    const store = dbCalendarStore(db)
    expect(await store.defaultVisibility(ben)).toBeNull()
    await store.setDefaultVisibility(ben, 'private', new Date())
    await store.setDefaultVisibility(ben, 'company', new Date())
    expect(await store.defaultVisibility(ben)).toBe('company')
  })
})
