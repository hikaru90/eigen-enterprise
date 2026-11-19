import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbCallsStore } from './db-store'
import { newCall, setTranscribe } from './state'
import { dbTranscriptStore } from './transcript-db-store'

/**
 * Call transcript segments against real Postgres (the test DB, :5433,
 * migration 0157 applied): stored in arrival order (seq), read merged by time,
 * a live reader's cursor, counts per call, and the participant's transcription
 * switch surviving a locked mutation. Needs DATABASE_URL; skipped without it.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('dbTranscriptStore (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const ids: string[] = []

  const make = async () => {
    const id = randomUUID()
    ids.push(id)
    const rec = newCall({
      id,
      roomName: `ee-call-${id}`,
      contextKind: 'meeting',
      contextId: null,
      title: 'Transcript spec',
      startedBy: 'pg-ann',
      startedByParticipant: true,
      invitees: ['pg-ben'],
      now: new Date(),
    })
    expect(await dbCallsStore(db).insert(rec)).toEqual({ ok: true })
    return id
  }

  const at = (s: number) => new Date(Date.UTC(2026, 10, 19, 10, 0, s))

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    if (ids.length > 0) await sql`delete from "call" where id in ${sql(ids)}`
    await sql.end()
  })

  it('adds segments with an increasing seq and reads them merged by start time', async () => {
    const id = await make()
    const store = dbTranscriptStore(db)
    const b = await store.add({ callId: id, speakerId: 'pg-ben', speakerKind: 'member', speakerName: 'Ben', startedAt: at(40), endedAt: at(60), text: 'zweiter' })
    const a = await store.add({ callId: id, speakerId: 'pg-ann', speakerKind: 'member', speakerName: 'Ann', startedAt: at(30), endedAt: at(60), text: 'erster' })
    expect(a.seq).toBeGreaterThan(b.seq)
    expect(a.createdAt).toBeInstanceOf(Date)
    const all = await store.list(id)
    expect(all.map((s) => s.text)).toEqual(['erster', 'zweiter'])
    expect(all[0]).toMatchObject({ callId: id, speakerId: 'pg-ann', speakerKind: 'member', speakerName: 'Ann', startedAt: at(30), endedAt: at(60) })
    // A live reader's cursor: only what arrived after the seq it last saw.
    expect((await store.list(id, b.seq)).map((s) => s.text)).toEqual(['erster'])
    expect(await store.list(id, a.seq)).toEqual([])
  })

  it('counts segments per call (calls without any are absent)', async () => {
    const one = await make()
    const none = await make()
    const store = dbTranscriptStore(db)
    await store.add({ callId: one, speakerId: 'guest:g1', speakerKind: 'guest', speakerName: 'Kim', startedAt: at(0), endedAt: at(30), text: 'Hallo' })
    await store.add({ callId: one, speakerId: 'pg-ann', speakerKind: 'member', speakerName: 'Ann', startedAt: at(1), endedAt: at(31), text: 'Hi' })
    const counts = await store.countByCall([one, none])
    expect(counts.get(one)).toBe(2)
    expect(counts.has(none)).toBe(false)
    expect((await store.countByCall([])).size).toBe(0)
  })

  it('the database refuses an empty text or an end before the start', async () => {
    const id = await make()
    const store = dbTranscriptStore(db)
    await expect(store.add({ callId: id, speakerId: 'pg-ann', speakerKind: 'member', speakerName: 'Ann', startedAt: at(0), endedAt: at(30), text: '' })).rejects.toThrow()
    await expect(store.add({ callId: id, speakerId: 'pg-ann', speakerKind: 'member', speakerName: 'Ann', startedAt: at(30), endedAt: at(0), text: 'x' })).rejects.toThrow()
  })

  it('a participant’s transcription switch is stored by a mutation (default on)', async () => {
    const id = await make()
    const calls = dbCallsStore(db)
    expect((await calls.get(id))!.participants.map((p) => p.transcribe)).toEqual([true, true])
    await calls.mutate(id, (r) => setTranscribe(r, 'pg-ben', false))
    const stored = await calls.get(id)
    expect(stored!.participants.find((p) => p.userId === 'pg-ben')?.transcribe).toBe(false)
    expect(stored!.participants.find((p) => p.userId === 'pg-ann')?.transcribe).toBe(true)
  })

  it('deleting the call deletes its transcript', async () => {
    const id = await make()
    const store = dbTranscriptStore(db)
    await store.add({ callId: id, speakerId: 'pg-ann', speakerKind: 'member', speakerName: 'Ann', startedAt: at(0), endedAt: at(30), text: 'weg' })
    await sql`delete from "call" where id = ${id}`
    expect(await store.list(id)).toEqual([])
  })
})
