import type { HandoverEntry } from './store'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbHandoverStore } from './db-store'
import { HandoverTopicTakenError } from './store'

/** The Postgres store against a database with migration 0184 applied (DATABASE_URL); skipped without it. */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('handover store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const owner = `pg-spec-${randomUUID()}`

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 4, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    await sql`delete from handovers where owner_id = ${owner}`
    await sql.end()
  })

  const entry = (handoverId: string, over: Partial<HandoverEntry> = {}): HandoverEntry => {
    const at = new Date('2026-11-25T09:00:00Z')
    return {
      id: randomUUID(),
      handoverId,
      entryOn: '2026-11-25',
      topic: 'Office lease',
      sentence: 'Two options for the renewal.',
      status: 'decision_needed',
      link: '/m/drive/file/abc',
      assigneeId: null,
      assignedTaskId: null,
      writtenVia: 'person',
      createdAt: at,
      updatedAt: at,
      ...over,
    }
  }

  it('keeps handovers and their entries newest first, one entry per topic', async () => {
    const store = dbHandoverStore(() => db)
    const at = new Date('2026-11-25T09:00:00Z')
    const id = randomUUID()
    await store.insertHandover({ id, ownerId: owner, title: 'Handover to Alex', subjectId: 'alex', createdAt: at, updatedAt: at })
    expect(await store.getHandover(id)).toMatchObject({ title: 'Handover to Alex', subjectId: 'alex' })

    const older = entry(id, { topic: 'EXIST grant', entryOn: '2026-11-20', status: 'for_info', link: null })
    const newer = entry(id)
    await store.insertEntry(older)
    await store.insertEntry(newer)
    expect((await store.listEntries([id])).map((e) => e.topic)).toEqual(['Office lease', 'EXIST grant'])
    expect((await store.entryByTopic(id, '  office LEASE '))?.id).toBe(newer.id)

    await expect(store.insertEntry(entry(id, { topic: 'OFFICE LEASE' }))).rejects.toBeInstanceOf(HandoverTopicTakenError)
    await expect(store.updateEntry(older.id, { topic: 'Office Lease' })).rejects.toBeInstanceOf(HandoverTopicTakenError)

    expect(await store.updateEntry(newer.id, { status: 'in_progress', link: null })).toMatchObject({ status: 'in_progress', link: null })
    expect(await store.deleteEntry(newer.id)).toBe(true)
    expect(await store.deleteEntry(newer.id)).toBe(false)

    const later = new Date('2026-11-26T09:00:00Z')
    await store.touchHandover(id, later)
    expect((await store.getHandover(id))?.updatedAt.toISOString()).toBe(later.toISOString())
  })
})
