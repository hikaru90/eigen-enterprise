import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { CALLS_NOTIFY_CHANNEL, dbCallsStore } from './db-store'
import { hashGuestToken } from './guests'
import { accept, addGuests, guestIdentity, joined, nameGuest, newCall, revokeGuest } from './state'

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

  it('windowed meetings with guests: stored, found by token hash, guests added / named / revoked, swept by window end', async () => {
    const store = dbCallsStore(db)
    const t = new Date(Math.floor(Date.now() / 1000) * 1000)
    const start = new Date(t.getTime() - 3_600_000)
    const base = make({ contextKind: 'meeting', contextId: null, invitees: [], now: t, window: { start, end: new Date(start.getTime() + 1_800_000) } })
    const g = (n: number) => ({
      id: randomUUID(),
      callId: base.call.id,
      email: `g${n}@example.org`,
      tokenHash: hashGuestToken(`${base.call.id}-${n}`),
      invitedBy: 'pg-ann',
      invitedAt: t,
      displayName: null,
      revokedAt: null,
    })
    const rec = addGuests(base, [g(1)], t)
    expect(await store.insert(rec)).toEqual({ ok: true })
    expect(await store.get(rec.call.id)).toEqual(rec)
    expect((await store.getByGuestTokenHash(rec.guests[0]!.tokenHash))?.call.id).toBe(rec.call.id)
    expect(await store.getByGuestTokenHash(hashGuestToken('nobody'))).toBeNull()
    expect((await store.liveForUser('pg-ann')).map((r) => r.call.id)).toContain(rec.call.id)

    const g2 = g(2)
    await store.mutate(rec.call.id, (r) => revokeGuest(nameGuest(addGuests(r, [g2], t), rec.guests[0]!.id, 'Ony Kunde'), g2.id, t))
    const got = (await store.get(rec.call.id))!
    expect(got.guests.map((x) => [x.email, x.displayName, x.revokedAt?.getTime() ?? null])).toEqual([
      ['g1@example.org', 'Ony Kunde', null],
      ['g2@example.org', null, t.getTime()],
    ])
    expect(got.participants.map((p) => p.userId)).toContain(guestIdentity(g2.id))

    expect(await store.windowsEndedBefore(new Date(t.getTime() - 60_000))).toContain(rec.call.id)
    expect(await store.windowsEndedBefore(new Date(start.getTime()))).not.toContain(rec.call.id)
    await expect(sql`update call_guest set token_hash = 'plain-token' where id = ${g2.id}`).rejects.toThrow() // hashes only
    await expect(sql`update "call" set scheduled_end = scheduled_start where id = ${rec.call.id}`).rejects.toThrow()
  })
})
