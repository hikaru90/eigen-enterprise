import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { CALLS_NOTIFY_CHANNEL, dbCallsStore } from './db-store'
import { accept, joined, newCall } from './state'

/**
 * The Calls store against real Postgres (the test DB, :5433, migration 0122
 * applied): the one-live-call-per-conversation index, locked mutations,
 * pg_notify on every change. Needs DATABASE_URL; skipped without it.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('dbCallsStore (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const contextId = `pg-spec-${randomUUID()}`
  const ids: string[] = []

  const make = (over: Partial<Parameters<typeof newCall>[0]> = {}) => {
    const id = randomUUID()
    ids.push(id)
    return newCall({
      id,
      roomName: `ee-call-${id}`,
      contextKind: 'dm',
      contextId,
      title: 'Ann, Ben',
      startedBy: 'pg-ann',
      startedByParticipant: true,
      invitees: ['pg-ben'],
      now: new Date(),
      ...over,
    })
  }

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 4, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    if (ids.length) await sql`delete from "call" where id in ${sql(ids)}`
    await sql.end()
  })

  it('inserts and reads back a call with its participants (starter first)', async () => {
    const store = dbCallsStore(db)
    const rec = make()
    expect(await store.insert(rec)).toEqual({ ok: true })
    const got = await store.get(rec.call.id)
    expect(got).toEqual(rec)
    expect(await store.getByRoom(rec.call.roomName)).toEqual(rec)
    expect((await store.liveForContext('dm', contextId))?.call.id).toBe(rec.call.id)
    expect((await store.listForUser('pg-ben', 5)).map((r) => r.call.id)).toContain(rec.call.id)
    expect((await store.liveForUser('pg-ann')).map((r) => r.call.id)).toContain(rec.call.id)
  })

  it('a second live call for the same conversation is refused and returns the existing one', async () => {
    const store = dbCallsStore(db)
    const existing = await store.liveForContext('dm', contextId)
    const clash = make({ startedBy: 'pg-ben', invitees: ['pg-ann'] })
    const res = await store.insert(clash)
    expect(res).toEqual({ ok: false, existing })
    ids.pop()
  })

  it('mutate stores the transition and notifies; a no-op stores and notifies nothing', async () => {
    const store = dbCallsStore(db)
    const live = (await store.liveForContext('dm', contextId))!
    const notified: string[] = []
    const listener = await sql.listen(CALLS_NOTIFY_CHANNEL, (payload) => notified.push(payload))
    try {
      const t = new Date()
      const out = await store.mutate(live.call.id, (r) => joined(joined(accept(r, 'pg-ben', t), 'pg-ann', t), 'pg-ben', t))
      expect(out!.after.call.state).toBe('active')
      const stored = (await store.get(live.call.id))!
      expect(stored.call.state).toBe('active')
      expect(stored.participants.find((p) => p.userId === 'pg-ben')).toMatchObject({ response: 'accepted', leftAt: null })
      expect(stored.participants.find((p) => p.userId === 'pg-ben')!.joinedAt).not.toBeNull()
      await store.mutate(live.call.id, (r) => r)
      await new Promise((r) => setTimeout(r, 100))
      expect(notified.filter((id) => id === live.call.id)).toHaveLength(1)
    } finally {
      await listener.unlisten()
    }
  })

  it('a throw inside the change stores nothing', async () => {
    const store = dbCallsStore(db)
    const live = (await store.liveForContext('dm', contextId))!
    await expect(
      store.mutate(live.call.id, () => {
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
    expect(await store.get(live.call.id)).toEqual(live)
  })

  it('concurrent mutations serialize on the row lock (no lost update)', async () => {
    const store = dbCallsStore(db)
    const rec = make({ contextKind: 'meeting', contextId: null, invitees: ['pg-x', 'pg-y'] })
    await store.insert(rec)
    const t = new Date()
    await Promise.all([store.mutate(rec.call.id, (r) => accept(r, 'pg-x', t)), store.mutate(rec.call.id, (r) => accept(r, 'pg-y', t))])
    const got = (await store.get(rec.call.id))!
    expect(got.participants.filter((p) => p.response === 'accepted').map((p) => p.userId).sort()).toEqual(['pg-ann', 'pg-x', 'pg-y'])
  })

  it('lists ringing calls by start time and the check constraints hold', async () => {
    const store = dbCallsStore(db)
    const old = make({ contextKind: 'meeting', contextId: null, now: new Date(Date.now() - 120_000) })
    await store.insert(old)
    expect(await store.ringingStartedBefore(new Date(Date.now() - 60_000))).toContain(old.call.id)
    await expect(sql`update "call" set state = 'ended' where id = ${old.call.id}`).rejects.toThrow() // ended needs ended_at
    await expect(sql`update "call" set context_id = 'x' where id = ${old.call.id}`).rejects.toThrow() // a meeting has no context
  })
})
