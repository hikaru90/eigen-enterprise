import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { appendEventInTx, dbMessagesStore } from './db-store'

/**
 * Reliability fix A against real Postgres (the test DB, :5433): event ids
 * must commit in id order, so a cursor (`eventsAfter`) can never skip an event
 * that commits late. Needs DATABASE_URL with migrations applied (0111);
 * skipped without it.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('message_events × interleaved transactions (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  let conversationId: string

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 4, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
    conversationId = randomUUID()
    await sql`insert into message_conversations (id, kind, name, created_by) values (${conversationId}, 'channel', ${`pg-spec-${conversationId}`}, 'pg-spec')`
  })

  afterAll(async () => {
    await sql`delete from message_conversations where id = ${conversationId}`
    await sql.end()
  })

  const ev = () => ({ kind: 'message.edited' as const, conversationId, messageId: null, userId: null })

  it('a later append waits for an earlier uncommitted one: a reader never sees a higher id before a lower one', async () => {
    const store = dbMessagesStore(db)
    let releaseA!: () => void
    const holdA = new Promise<void>((r) => (releaseA = r))
    let idA = 0
    let aInserted!: () => void
    const aReady = new Promise<void>((r) => (aInserted = r))

    // Transaction A allocates its id, then stalls before committing.
    const txA = db.transaction(async (tx) => {
      idA = await appendEventInTx(tx, ev())
      aInserted()
      await holdA
    })
    await aReady

    // B starts while A is open. Before the fix B got idA+1 and committed first.
    let idB = 0
    const txB = store.appendEvent(ev()).then((id) => (idB = id))
    await new Promise((r) => setTimeout(r, 300))
    expect(idB).toBe(0) // still blocked behind A

    // What a stream catching up right now sees: nothing past A (uncommitted), so the cursor stays below A.
    const cursor = idA - 1
    expect((await store.eventsAfter(cursor, 100)).filter((e) => e.conversationId === conversationId)).toEqual([])

    releaseA()
    await txA
    await txB
    expect(idB).toBeGreaterThan(idA)
    const seen = (await store.eventsAfter(cursor, 100)).filter((e) => e.conversationId === conversationId).map((e) => e.id)
    expect(seen).toEqual([idA, idB])
  })

  it('many concurrent appends: every id becomes visible in order, none skipped by an incremental reader', async () => {
    const store = dbMessagesStore(db)
    const start = await store.latestEventId()
    let cursor = start
    const delivered: number[] = []
    let done = false
    const reader = (async () => {
      while (!done) {
        const batch = (await store.eventsAfter(cursor, 1000)).filter((e) => e.conversationId === conversationId)
        for (const e of batch) delivered.push(e.id)
        const all = await store.eventsAfter(cursor, 1000)
        if (all.length) cursor = all.at(-1)!.id
        await new Promise((r) => setTimeout(r, 2))
      }
    })()
    const ids = await Promise.all(Array.from({ length: 40 }, () => store.appendEvent(ev())))
    await new Promise((r) => setTimeout(r, 50))
    done = true
    await reader
    // Drain whatever the last poll missed.
    for (const e of (await store.eventsAfter(cursor, 1000)).filter((x) => x.conversationId === conversationId)) delivered.push(e.id)
    expect(delivered.sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b))
  })

  it('thread stats: live reply count, last reply and the latest distinct repliers (P-5 summary avatars)', async () => {
    const store = dbMessagesStore(db)
    const at = (min: number) => new Date(Date.UTC(2026, 10, 4, 9, min))
    const parent = { id: randomUUID(), conversationId, authorId: 'olga', body: 'p', parentId: null, createdAt: at(0), editedAt: null, deletedAt: null }
    await store.insertMessage(parent)
    const replies: Array<[string, number, boolean]> = [['bea', 1, false], ['carl', 2, false], ['bea', 3, false], ['dan', 4, false], ['eve', 5, true]]
    for (const [authorId, min, deleted] of replies) {
      await store.insertMessage({ id: randomUUID(), conversationId, authorId, body: 'r', parentId: parent.id, createdAt: at(min), editedAt: null, deletedAt: deleted ? at(6) : null })
    }
    const st = (await store.threadStats([parent.id])).get(parent.id)
    expect(st).toEqual({ replyCount: 4, lastReplyAt: at(4), replierIds: ['dan', 'bea', 'carl'] })
    expect((await store.threadStats([randomUUID()])).size).toBe(0)
  })
})
