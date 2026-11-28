import type { HubSpanV1 } from '../payload'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbHubTraceStore } from './db-store'

/** The hub's trace tables against real Postgres (migration 0202). Skipped without DATABASE_URL; its rows are removed after. */

const url = process.env.DATABASE_URL?.trim()

const span = (over: Partial<HubSpanV1> = {}): HubSpanV1 => ({
  trace_id: randomUUID(), span_id: randomUUID(), parent_id: null, kind: 'tool_call', run_kind: null, tool: 'memory.list_tasks',
  log_context: null, model: null, provider_kind: null, tokens_in: null, tokens_out: null, cost_usd: null, duration_ms: 100,
  attempt: null, start_offset_ms: 0, outcome: 'ok', error_code: null, audit_class: 'read', via: 'person', app_version: '9.9.9',
  ee_version: null, day: '2026-01-10', ...over,
})

describe.skipIf(!url)('hub traces store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const installs = [randomUUID(), randomUUID()]

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
    await sql`delete from hub_trace_daily where app_version = '9.9.9'`
  })

  afterAll(async () => {
    await sql`delete from hub_trace_spans where install_id in ${sql(installs)}`
    await sql`delete from hub_trace_batches where install_id in ${sql(installs)}`
    await sql`delete from hub_installs where install_id in ${sql(installs)}`
    await sql`delete from hub_trace_daily where app_version = '9.9.9'`
    await sql.end()
  })

  it('stores a batch once; stats group by tool with error rate and p95; withdraw removes it', async () => {
    const store = dbHubTraceStore(db)
    const b = randomUUID()
    const spans = [span({ duration_ms: 100 }), span({ duration_ms: 300, outcome: 'error', error_code: 'other' }), span({ tool: 'other', duration_ms: 50 })]
    expect(await store.insertBatch(installs[0]!, b, spans, new Date())).toBe('created')
    expect(await store.insertBatch(installs[0]!, b, spans, new Date())).toBe('duplicate')
    const rows = await store.stats({ groupBy: 'tool', kind: 'tool_call', fromDay: '2026-01-10', toDay: '2026-01-10' })
    const list = rows.find((r) => r.key === 'memory.list_tasks')!
    expect(list).toMatchObject({ spans: 2, errors: 1, errorRate: 0.5, installs: 1, p95Ms: 290 })
    expect((await store.listRuns({ outcome: 'error', errorCode: null, appVersion: '9.9.9', limit: 10 })).map((s) => s.span_id)).toContain(spans[1]!.span_id)
    expect(await store.getTrace(installs[0]!, spans[0]!.trace_id)).toHaveLength(1)
    expect(await store.deleteBatch(installs[0]!, b)).toBe(3)
  })

  it('rolls days up, keeps the rollup after the raw spans expire, and drops a revoked install’s spans', async () => {
    const store = dbHubTraceStore(db)
    await store.insertBatch(installs[0]!, randomUUID(), [span({ day: '2026-01-01' }), span({ day: '2026-01-01', outcome: 'error' })], new Date())
    await store.insertBatch(installs[1]!, randomUUID(), [span({ day: '2026-03-01' })], new Date())
    await sql`insert into hub_installs (install_id, public_key, app_version, revoked_at) values (${installs[1]!}, 'k', '9.9.9', now())`
    expect(await store.rollup('2026-02-01')).toBeGreaterThan(0)
    const out = await store.retention('2026-01-02')
    expect(out.expired).toBeGreaterThanOrEqual(2)
    expect(out.revoked).toBe(1)
    const rows = await store.stats({ groupBy: 'day', kind: null, fromDay: '2026-01-01', toDay: '2026-01-01' })
    expect(rows).toEqual([expect.objectContaining({ key: '2026-01-01', spans: 2, errors: 1 })])
  })
})
