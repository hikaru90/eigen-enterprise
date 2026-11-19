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
        // One read per poll: a second read could advance the cursor past an event the first missed.
        const all = await store.eventsAfter(cursor, 1000)
        for (const e of all) if (e.conversationId === conversationId) delivered.push(e.id)
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
    const parent = { id: randomUUID(), conversationId, authorId: 'olga', body: 'p', parentId: null, replyToId: null, createdAt: at(0), editedAt: null, deletedAt: null, call: null }
    await store.insertMessage(parent)
    const replies: Array<[string, number, boolean]> = [['bea', 1, false], ['carl', 2, false], ['bea', 3, false], ['dan', 4, false], ['eve', 5, true]]
    for (const [authorId, min, deleted] of replies) {
      await store.insertMessage({ id: randomUUID(), conversationId, authorId, body: 'r', parentId: parent.id, replyToId: null, createdAt: at(min), editedAt: null, deletedAt: deleted ? at(6) : null, call: null })
    }
    const st = (await store.threadStats([parent.id])).get(parent.id)
    expect(st).toEqual({ replyCount: 4, lastReplyAt: at(4), replierIds: ['dan', 'bea', 'carl'] })
    expect((await store.threadStats([randomUUID()])).size).toBe(0)
  })

  it('call lines (0123): stored with their call data, one per call; a malformed one is refused by the database', async () => {
    const store = dbMessagesStore(db)
    const callId = randomUUID()
    const line = (call: unknown) => ({
      id: randomUUID(),
      conversationId,
      authorId: 'bea',
      body: '',
      parentId: null,
      replyToId: null,
      createdAt: new Date(),
      editedAt: null,
      deletedAt: null,
      call: call as { callId: string; outcome: 'ended'; durationSeconds: number },
    })
    const first = line({ callId, outcome: 'ended', durationSeconds: 245 })
    expect(await store.insertCallLine(first)).toBe(true)
    expect(await store.getMessage(first.id)).toMatchObject({ body: '', call: { callId, outcome: 'ended', durationSeconds: 245 } })
    expect(await store.insertCallLine(line({ callId, outcome: 'ended', durationSeconds: 245 }))).toBe(false)
    await expect(store.insertCallLine(line({ callId: randomUUID(), outcome: 'missed', durationSeconds: 10 }))).rejects.toThrow()
    await expect(store.insertCallLine(line({ callId: randomUUID(), outcome: 'hung', durationSeconds: null }))).rejects.toThrow()
  })

  it('quoted replies (0151): reply_to_id is stored, getMessages batches, and a hard-deleted original clears the link', async () => {
    const store = dbMessagesStore(db)
    const base = { conversationId, authorId: 'bea', parentId: null, editedAt: null, deletedAt: null, call: null }
    const original = { ...base, id: randomUUID(), body: 'original', replyToId: null, createdAt: new Date() }
    const reply = { ...base, id: randomUUID(), body: 'reply', replyToId: original.id, createdAt: new Date() }
    await store.insertMessage(original)
    await store.insertMessage(reply)
    expect(await store.getMessage(reply.id)).toMatchObject({ replyToId: original.id })
    expect((await store.getMessages([original.id, reply.id, randomUUID()])).map((m) => m.id).sort()).toEqual([original.id, reply.id].sort())
    expect(await store.getMessages([])).toEqual([])
    await sql`delete from messages where id = ${original.id}`
    expect(await store.getMessage(reply.id)).toMatchObject({ replyToId: null })
    await expect(store.insertMessage({ ...base, id: randomUUID(), body: 'dangling', replyToId: randomUUID(), createdAt: new Date() })).rejects.toThrow()
  })

  it('voice recordings (0156): an attachment keeps its recording length; ordinary files have none', async () => {
    const store = dbMessagesStore(db)
    const m = { id: randomUUID(), conversationId, authorId: 'bea', body: 'Treffen um drei', parentId: null, replyToId: null, createdAt: new Date(), editedAt: null, deletedAt: null, call: null }
    await store.insertMessage(m)
    await store.insertAttachments([
      { messageId: m.id, fileId: 'voice-file', position: 0, name: 'Voice message.webm', mime: 'audio/webm;codecs=opus', size: 9000, voiceDurationMs: 4200 },
      { messageId: m.id, fileId: 'plain-file', position: 1, name: 'notes.md', mime: 'text/markdown', size: 4, voiceDurationMs: null },
    ])
    expect(await store.attachmentsFor([m.id])).toEqual([
      { messageId: m.id, fileId: 'voice-file', position: 0, name: 'Voice message.webm', mime: 'audio/webm;codecs=opus', size: 9000, voiceDurationMs: 4200 },
      { messageId: m.id, fileId: 'plain-file', position: 1, name: 'notes.md', mime: 'text/markdown', size: 4, voiceDurationMs: null },
    ])
  })
})
