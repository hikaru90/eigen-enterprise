import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbTraceSourceReader, dbTraceStore } from './db-store'

/**
 * The traces store and source reader against real Postgres (the test DB with migration 0201).
 * Skipped without DATABASE_URL. Rows it makes are removed after; the settings row is restored.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('traces store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const batchIds: string[] = []
  const eventIds: string[] = []
  let saved: unknown[]

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
    saved = await sql`select * from trace_share_settings`
    await sql`delete from trace_export_cursor where source = 'tool_call'`
  })

  afterAll(async () => {
    if (batchIds.length) await sql`delete from trace_batch where id in ${sql(batchIds)}`
    if (eventIds.length) await sql`delete from kernel_events where id in ${sql(eventIds)}`
    await sql`delete from trace_value_verdict where value like 'pgspec.%'`
    await sql`delete from trace_export_cursor where source = 'tool_call'`
    if (saved.length === 0) await sql`delete from trace_share_settings`
    await sql.end()
  })

  it('makes the settings row on first read: on, with a salt that stays', async () => {
    const store = dbTraceStore(db)
    const a = await store.settings()
    const b = await store.settings()
    expect(a.enabled).toBe(true)
    expect(a.salt.length).toBeGreaterThan(20)
    expect(b.salt).toBe(a.salt)
  })

  it('writes a batch and its cursors in one go; due → sent → withdrawn', async () => {
    const store = dbTraceStore(db)
    const now = new Date()
    await store.cursor('tool_call', new Date(0))
    const id = randomUUID()
    batchIds.push(id)
    await store.createBatch(
      { id, state: 'pending', spanCount: 2, body: { v: 1 }, withheld: [{ field: 'tool', value: 'a.b' }], attempts: 0, nextAttemptAt: now, lastError: null, createdAt: now, sentAt: null, withdrawnAt: null },
      { tool_call: { at: now, id: 'zzz' } },
    )
    expect((await store.cursor('tool_call', new Date(0))).id).toBe('zzz')
    expect((await store.dueBatches(new Date(now.getTime() + 1), 10)).map((b) => b.id)).toContain(id)
    await store.markSent(id, now)
    expect(await store.markWithdrawn(id, now)).toEqual([id])
    expect((await store.getBatch(id))!).toMatchObject({ state: 'withdrawn', withheld: [{ field: 'tool', value: 'a.b' }] })
  })

  it('caches verdicts per (field, value)', async () => {
    const store = dbTraceStore(db)
    await store.verdicts.put({ field: 'tool', value: 'pgspec.one' }, 'usage_meta', new Date())
    const got = await store.verdicts.get([{ field: 'tool', value: 'pgspec.one' }, { field: 'model', value: 'pgspec.one' }])
    expect([...got.values()]).toEqual(['usage_meta'])
  })

  it('reads tool.executed rows after the cursor and before `until`, with the run’s trace id', async () => {
    const t = new Date(Date.now() - 120_000)
    const trace = randomUUID()
    const [e] = await sql`insert into kernel_events (ts, type, payload) values (${t.toISOString()}, 'tool.executed',
      ${JSON.stringify({ tool: 'memory.list_tasks', auditClass: 'read', ok: true, durationMs: 4, traceId: trace, activity: 'Listed Jane’s tasks' })}::jsonb) returning id`
    eventIds.push(e!.id)
    const read = dbTraceSourceReader(db, async () => [])
    const rows = await read('tool_call', { at: new Date(t.getTime() - 1), id: '' }, new Date(), 10)
    const mine = rows.find((r) => r.localId === e!.id)!
    expect(mine).toMatchObject({ source: 'tool_call', tool: 'memory.list_tasks', ok: true, traceKey: trace, durationMs: 4 })
    expect(JSON.stringify(mine)).not.toContain('Jane')
    expect(await read('tool_call', mine.cursor, new Date(), 10)).not.toContainEqual(expect.objectContaining({ localId: e!.id }))
  })

  it('every table source reads without error (the SQL matches the schema)', async () => {
    const read = dbTraceSourceReader(db, async () => [])
    for (const source of ['llm_call', 'tool_call', 'run', 'job', 'upgrade'] as const) {
      await expect(read(source, { at: new Date(0), id: '' }, new Date(), 5)).resolves.toBeInstanceOf(Array)
    }
  })
})
