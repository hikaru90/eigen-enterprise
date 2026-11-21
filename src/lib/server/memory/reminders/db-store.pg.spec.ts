import type { Reminder } from './store'
import { randomUUID } from 'node:crypto'
import { sql as sql_ } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { activateTenantDbSession, deactivateTenantDbSession } from '$lib/server/db/tenant-session'
import { dbReminderStore, type AsUser } from './db-store'

/**
 * The Postgres store against a database with migration 0163 applied
 * (DATABASE_URL); skipped without it. Runs as the app role with the person's
 * RLS session — the way withDbUser does live — so it pins the privacy, not
 * only the queries.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('reminders store (Postgres, RLS)', () => {
  let sql: postgres.Sql
  const ony = `pg-spec-rem-a-${randomUUID()}`
  const other = `pg-spec-rem-b-${randomUUID()}`

  const asUser: AsUser = async (userId, fn) => {
    const reserved = await sql.reserve()
    try {
      await activateTenantDbSession(reserved, userId)
      // A reserved handle has no `options`; drizzle needs the pool's (as createScopedDrizzle does).
      Object.assign(reserved, { options: sql.options })
      return await fn(drizzle(reserved) as unknown as AppDatabase)
    } finally {
      await deactivateTenantDbSession(reserved)
      reserved.release()
    }
  }
  const store = () => dbReminderStore(asUser)

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 4, onnotice: () => {} })
    for (const id of [ony, other]) {
      await sql`insert into "user" (id, name, email) values (${id}, ${id}, ${`${id}@spec.test`})`
    }
  })

  afterAll(async () => {
    await sql`delete from "user" where id in (${ony}, ${other})`
    await sql.end()
  })

  const reminder = (over: Partial<Reminder> = {}): Reminder => {
    const at = new Date('2026-11-21T12:00:00.000Z')
    return {
      id: randomUUID(),
      userId: ony,
      title: 'LinkedIn posts',
      note: 'Prepare, check or send',
      weekdays: ['MO', 'TH'],
      time: '09:00',
      timeZone: 'Europe/Berlin',
      status: 'active',
      handledThrough: at,
      snoozedUntil: null,
      createdVia: 'person',
      createdAt: at,
      updatedAt: at,
      ...over,
    }
  }

  it('round-trips a reminder for its owner', async () => {
    const r = reminder()
    await store().insert(r)
    expect(await store().get(ony, r.id)).toEqual(r)
    expect((await store().list(ony)).map((x) => x.id)).toContain(r.id)
  })

  it('never shows or changes it for anyone else — not even when they name the owner', async () => {
    const r = reminder()
    await store().insert(r)
    expect(await store().get(other, r.id)).toBeNull()
    expect(await store().list(other)).toEqual([])
    expect(await store().update(other, r.id, { title: 'mine now' })).toBeNull()
    expect(await store().delete(other, r.id)).toBe(false)
    // The RLS policy itself: as `other`, a filter on Ony's id finds nothing.
    const leaked = await asUser(other, (db) => db.execute(sql_`select id from reminders where user_id = ${ony}`))
    expect([...leaked]).toEqual([])
  })

  it('refuses a row written for someone else under one’s own session', async () => {
    await expect(asUser(other, (db) => db.execute(sql_`insert into reminders (id, user_id, title, weekdays, time_of_day, time_zone, handled_through, created_via) values (${randomUUID()}, ${ony}, 'x', array['MO'], '09:00', 'UTC', now(), 'person')`))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } })
  })

  it('updates under the handled-through guard exactly once', async () => {
    const r = reminder()
    await store().insert(r)
    const next = new Date('2026-11-23T08:00:00.000Z')
    expect((await store().update(ony, r.id, { handledThrough: next }, { ifHandledThrough: r.handledThrough }))?.handledThrough).toEqual(next)
    expect(await store().update(ony, r.id, { handledThrough: new Date('2026-11-26T08:00:00.000Z') }, { ifHandledThrough: r.handledThrough })).toBeNull()
  })

  it('enforces the weekday and time checks in the table', async () => {
    await expect(store().insert(reminder({ weekdays: [] }))).rejects.toThrow()
    await expect(store().insert(reminder({ time: '25:00' }))).rejects.toThrow()
  })

  it('deletes for good', async () => {
    const r = reminder()
    await store().insert(r)
    expect(await store().delete(ony, r.id)).toBe(true)
    expect(await store().get(ony, r.id)).toBeNull()
  })
})
