import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbContributeStore } from './db-store'

/**
 * The DB store against real Postgres (the test DB, :5433). Needs DATABASE_URL
 * with migrations applied (0121); skipped without it.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('contributions store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const ids: string[] = []

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    if (ids.length > 0) await sql`delete from contributions where id in ${sql(ids)}`
    await sql.end()
  })

  const row = (over: Partial<{ title: string; status: 'requested' | 'shipped' }> = {}) => {
    const id = randomUUID()
    ids.push(id)
    const at = new Date()
    return {
      id,
      title: over.title ?? `pg-spec ${id}`,
      kind: 'idea' as const,
      area: 'drive' as const,
      status: over.status ?? ('requested' as const),
      authorId: 'pg-spec-ana',
      note: null,
      createdAt: at,
      updatedAt: at,
      shippedAt: over.status === 'shipped' ? at : null,
    }
  }

  it('insert gives the author +1; votes upsert, remove and sum', async () => {
    const store = dbContributeStore(db)
    const c = row()
    await store.insert(c)
    expect((await store.get(c.id))?.score).toBe(1)
    await store.setVote(c.id, 'pg-spec-ben', 1)
    await store.setVote(c.id, 'pg-spec-ben', -1)
    await store.setVote(c.id, 'pg-spec-cy', -1)
    const got = await store.get(c.id)
    expect(got?.score).toBe(-1)
    expect(got?.votes.get('pg-spec-ben')).toBe(-1)
    await store.setVote(c.id, 'pg-spec-cy', 0)
    expect((await store.get(c.id))?.score).toBe(0)
  })

  it('lists by status newest first; update patches; the shipped constraint holds', async () => {
    const store = dbContributeStore(db)
    const a = row()
    await store.insert(a)
    const listed = await store.list(['requested'])
    expect(listed.find((r) => r.id === a.id)).toBeTruthy()
    const at = new Date()
    await store.update(a.id, { status: 'shipped', shippedAt: at, note: 'done', updatedAt: at })
    expect((await store.get(a.id))?.status).toBe('shipped')
    expect((await store.list(['requested'])).find((r) => r.id === a.id)).toBeUndefined()
    await expect(store.update(a.id, { status: 'requested', updatedAt: at })).rejects.toThrow()
    await expect(store.update(randomUUID(), { status: 'requested', updatedAt: at })).rejects.toThrow(/not found/)
  })
})
