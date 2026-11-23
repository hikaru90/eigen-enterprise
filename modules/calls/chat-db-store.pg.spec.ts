import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { CALLS_CHAT_NOTIFY_CHANNEL, chatSeqOf, dbChatStore } from './chat-db-store'
import { dbCallsStore } from './db-store'
import { newCall } from './state'

/**
 * A call's chat against real Postgres (the test DB, migration 0169 applied):
 * seq in arrival order, a reader's cursor and page size, one line by seq,
 * counts per call, the column checks, the wake-up on commit and the cascade
 * with its call. Needs DATABASE_URL; skipped without it.
 */

const url = process.env.DATABASE_URL?.trim()

describe('chatSeqOf (the NOTIFY payload)', () => {
  it('a positive whole number, nothing else', () => {
    expect(chatSeqOf('42')).toBe(42)
    for (const bad of ['', '0', '-1', '1.5', 'abc', ' 7', '007']) expect(() => chatSeqOf(bad)).toThrow()
  })
})

describe.skipIf(!url)('dbChatStore (Postgres)', () => {
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
      title: 'Chat spec',
      startedBy: 'pg-ann',
      startedByParticipant: true,
      invitees: ['pg-ben'],
      now: new Date(),
    })
    expect(await dbCallsStore(db).insert(rec)).toEqual({ ok: true })
    return id
  }

  const line = (callId: string, body: string, at = new Date()) => ({
    callId,
    authorId: 'pg-ann',
    authorKind: 'member' as const,
    authorName: 'Ann',
    body,
    createdAt: at,
  })

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 3, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    if (ids.length > 0) await sql`delete from "call" where id in ${sql(ids)}`
    await sql.end()
  })

  it('stores lines in arrival order; a cursor and a limit; one by seq; counts per call', async () => {
    const a = await make()
    const b = await make()
    const store = dbChatStore(db)
    const at = new Date(Date.UTC(2026, 10, 23, 10, 0, 0))
    const one = await store.add(line(a, 'eins', at))
    const other = await store.add({ ...line(b, 'Gast hier'), authorId: 'guest:x', authorKind: 'guest', authorName: 'Kim' })
    const two = await store.add(line(a, 'zwei'))
    expect(two.seq).toBeGreaterThan(one.seq)
    expect(one).toMatchObject({ callId: a, authorKind: 'member', authorName: 'Ann', body: 'eins', createdAt: at })
    expect((await store.list(a)).map((m) => m.body)).toEqual(['eins', 'zwei'])
    expect((await store.list(a, one.seq)).map((m) => m.body)).toEqual(['zwei'])
    expect((await store.list(a, undefined, 1)).map((m) => m.body)).toEqual(['eins'])
    expect(await store.get(other.seq)).toMatchObject({ authorId: 'guest:x', authorKind: 'guest', body: 'Gast hier' })
    expect(await store.get(0)).toBeNull()
    expect(await store.countByCall([a, b, randomUUID()])).toEqual(new Map([[a, 2], [b, 1]]))
    expect(await store.countByCall([])).toEqual(new Map())
  })

  it('the column checks: no empty or over-long line, a known author kind', async () => {
    const a = await make()
    const store = dbChatStore(db)
    await expect(store.add(line(a, ''))).rejects.toThrow()
    await expect(store.add(line(a, 'x'.repeat(4001)))).rejects.toThrow()
    await expect(store.add({ ...line(a, 'hi'), authorKind: 'bot' as never })).rejects.toThrow()
    expect(await store.list(a)).toEqual([])
  })

  it('wakes listeners on commit with the line’s seq; the call’s deletion takes its chat', async () => {
    const a = await make()
    const heard: string[] = []
    const listener = await sql.listen(CALLS_CHAT_NOTIFY_CHANNEL, (payload) => heard.push(payload))
    try {
      const m = await dbChatStore(db).add(line(a, 'weckt'))
      for (let i = 0; i < 50 && !heard.includes(String(m.seq)); i++) await new Promise((r) => setTimeout(r, 20))
      expect(heard).toContain(String(m.seq))
    } finally {
      await listener.unlisten()
    }
    await sql`delete from "call" where id = ${a}`
    expect(await dbChatStore(db).list(a)).toEqual([])
  })
})
