import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { kernelAgentSessionEvents } from '$lib/server/db/kernel.schema'

const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('DbAgentSessionLog integration (kernel_agent_session_events)', () => {
  type DbAgentSessionLog = import('./db-stores').DbAgentSessionLog
  type AppDatabase = import('$lib/server/db/context').AppDatabase

  let db: AppDatabase
  let makeLog: () => DbAgentSessionLog
  const sessionA = `log_int_a_${Date.now().toString(36)}`
  const sessionB = `log_int_b_${Date.now().toString(36)}`

  beforeAll(async () => {
    const [{ appSql, createScopedDrizzle }, { DbAgentSessionLog: Store }] = await Promise.all([
      import('$lib/server/db'),
      import('./db-stores'),
    ])
    db = createScopedDrizzle(appSql)
    makeLog = () => new Store(db)
  })

  afterAll(async () => {
    if (!db) return
    await db
      .delete(kernelAgentSessionEvents)
      .where(inArray(kernelAgentSessionEvents.sessionId, [sessionA, sessionB]))
      .catch(() => undefined)
  })

  it('appends events and a FRESH store instance reads them back in insertion order', async () => {
    const writer = makeLog()
    await writer.append({ sessionId: sessionA, agentId: 'orchestrator', kind: 'user', payload: { text: 'one' } })
    await writer.append({
      sessionId: sessionA,
      agentId: 'orchestrator',
      kind: 'assistant',
      payload: { text: 'reply one' },
    })
    await writer.append({ sessionId: sessionA, agentId: 'orchestrator', kind: 'user', payload: { text: 'two' } })
    await writer.append({ sessionId: sessionB, agentId: 'orchestrator', kind: 'user', payload: { text: 'other' } })

    // A new process would construct a new store — the table is the only memory.
    const reader = makeLog()
    expect((await reader.list(sessionA)).map((e) => [e.kind, e.payload])).toEqual([
      ['user', { text: 'one' }],
      ['assistant', { text: 'reply one' }],
      ['user', { text: 'two' }],
    ])
    expect((await reader.list(sessionB)).map((e) => e.payload)).toEqual([{ text: 'other' }])
  })

  it('a limit keeps the LAST n events in chronological order', async () => {
    const reader = makeLog()
    expect((await reader.list(sessionA, 2)).map((e) => e.payload)).toEqual([
      { text: 'reply one' },
      { text: 'two' },
    ])
  })

  it('rows are append-only data: id ordering is the ordering of record', async () => {
    const rows = await db
      .select({ id: kernelAgentSessionEvents.id, kind: kernelAgentSessionEvents.kind })
      .from(kernelAgentSessionEvents)
      .where(eq(kernelAgentSessionEvents.sessionId, sessionA))
    expect(rows.map((r) => r.kind)).toEqual(['user', 'assistant', 'user'])
  })
})
