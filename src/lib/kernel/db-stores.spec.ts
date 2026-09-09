import { getTableName } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import {
  DbActivationStore,
  DbAgentSessionLog,
  DbApprovalStore,
  DbEventSink,
  DbPrincipalStore,
} from './db-stores'

/**
 * Minimal chainable fake of the drizzle postgres-js builder surface used by
 * the kernel stores. Dispatches on table name; every await resolves with the
 * rows returned by the matching handler. Fail loud on unexpected chains.
 */

type SelectQuery = { where: unknown[]; orderBy: unknown[]; limit: number | undefined }

type FakeHandlers = {
  onInsert: (table: string, values: unknown, conflictSet: unknown) => unknown[]
  onSelect: (table: string, query: SelectQuery) => unknown[]
  onUpdate: (table: string, set: unknown, where: unknown[]) => unknown[]
}

type RecordedCall =
  | { op: 'insert'; table: string; values: unknown; conflictSet: unknown }
  | { op: 'select'; table: string; query: SelectQuery }
  | { op: 'update'; table: string; set: unknown; where: unknown[] }

function tableName(table: unknown): string {
  const name = getTableName(table as never)
  if (!name) throw new Error('fake db: unknown table')
  return name
}

function thenable(rows: () => unknown[]): PromiseLike<unknown[]> & { __rows: () => unknown[] } {
  const promise = Promise.resolve().then(rows)
  const node = {
    __rows: rows,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
  return node
}

function makeFakeDb(handlers: FakeHandlers): { db: AppDatabase; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []

  const db = {
    insert(table: unknown) {
      const name = tableName(table)
      return {
        values(values: unknown) {
          const call = { op: 'insert', table: name, values, conflictSet: undefined } as const
          calls.push(call)
          const run = () => handlers.onInsert(name, values, call.conflictSet)
          return {
            ...thenable(run),
            onConflictDoUpdate(config: { target: unknown; set: unknown }) {
              if (!config || typeof config.set !== 'object') {
                throw new Error('fake db: onConflictDoUpdate requires a set clause')
              }
              call.conflictSet = config.set
              return thenable(run)
            },
            returning(_projection?: unknown) {
              return thenable(run)
            },
          }
        },
      }
    },
    select(_projection?: unknown) {
      return {
        from(table: unknown) {
          const name = tableName(table)
          const query: SelectQuery = { where: [], orderBy: [], limit: undefined }
          const call = { op: 'select', table: name, query } as const
          calls.push(call)
          const run = () => handlers.onSelect(name, query)
          const node = {
            where(condition: unknown) {
              query.where.push(condition)
              return node
            },
            orderBy(...terms: unknown[]) {
              if (terms.length === 0) throw new Error('fake db: orderBy requires terms')
              query.orderBy.push(...terms)
              return node
            },
            limit(n: number) {
              query.limit = n
              return thenable(run)
            },
            ...thenable(run),
          }
          return node
        },
      }
    },
    update(table: unknown) {
      const name = tableName(table)
      return {
        set(values: unknown) {
          const where: unknown[] = []
          const node = {
            where(condition: unknown) {
              where.push(condition)
              return node
            },
            returning(_projection?: unknown) {
              return thenable(() => {
                calls.push({ op: 'update', table: name, set: values, where })
                return handlers.onUpdate(name, values, where)
              })
            },
            ...thenable(() => {
              calls.push({ op: 'update', table: name, set: values, where })
              return handlers.onUpdate(name, values, where)
            }),
          }
          return node
        },
      }
    },
  }

  return { db: db as unknown as AppDatabase, calls }
}

const noopHandlers: FakeHandlers = {
  onInsert: () => [],
  onSelect: () => [],
  onUpdate: () => [],
}

describe('DbEventSink', () => {
  it('inserts the kernel event with a Date ts and optional principal', async () => {
    const inserted: unknown[] = []
    const { db } = makeFakeDb({
      ...noopHandlers,
      onInsert: (_t, values) => {
        inserted.push(values)
        return []
      },
    })
    const sink = new DbEventSink(db)

    await sink.emit({
      id: 'ev-1',
      ts: '2026-09-07T10:00:00.000Z',
      type: 'tool.executed',
      principalId: 'p1',
      payload: { tool: 'memory.echo', ok: true },
    })
    await sink.emit({ id: 'ev-2', ts: '2026-09-07T10:01:00.000Z', type: 'audit', payload: {} })

    expect(inserted).toEqual([
      {
        id: 'ev-1',
        ts: new Date('2026-09-07T10:00:00.000Z'),
        type: 'tool.executed',
        principalId: 'p1',
        payload: { tool: 'memory.echo', ok: true },
      },
      { id: 'ev-2', ts: new Date('2026-09-07T10:01:00.000Z'), type: 'audit', payload: {} },
    ])
  })

  it('accepts a lazy db provider resolved per emit', async () => {
    let resolved = 0
    const { db } = makeFakeDb(noopHandlers)
    const sink = new DbEventSink(() => {
      resolved += 1
      return db
    })

    await sink.emit({ id: 'ev-1', ts: '2026-09-07T10:00:00.000Z', type: 'audit', payload: {} })
    expect(resolved).toBe(1)
  })

  it('persists source when present and omits the column when absent', async () => {
    const inserted: unknown[] = []
    const { db } = makeFakeDb({
      ...noopHandlers,
      onInsert: (_t, values) => {
        inserted.push(values)
        return []
      },
    })
    const sink = new DbEventSink(db)

    await sink.emit({
      id: 'ev-1',
      ts: '2026-09-07T10:00:00.000Z',
      type: 'tool.executed',
      source: 'urn:eigenenterprise:module:memory',
      payload: {},
    })
    await sink.emit({ id: 'ev-2', ts: '2026-09-07T10:01:00.000Z', type: 'audit', payload: {} })

    expect(inserted).toEqual([
      {
        id: 'ev-1',
        ts: new Date('2026-09-07T10:00:00.000Z'),
        type: 'tool.executed',
        source: 'urn:eigenenterprise:module:memory',
        payload: {},
      },
      { id: 'ev-2', ts: new Date('2026-09-07T10:01:00.000Z'), type: 'audit', payload: {} },
    ])
    expect('source' in (inserted[1] as object)).toBe(false)
  })
})

describe('DbActivationStore', () => {
  it('set upserts on module_id with the conflict clause', async () => {
    const { db, calls } = makeFakeDb(noopHandlers)
    const store = new DbActivationStore(db)

    await store.set('memory', true)

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (call.op !== 'insert') throw new Error('expected insert')
    expect(call.table).toBe('kernel_module_activations')
    expect(call.values).toMatchObject({ moduleId: 'memory', active: true })
    expect(call.values).toHaveProperty('updatedAt')
    expect(call.conflictSet).toMatchObject({ active: true })
  })

  it('get returns the stored flag and false for unknown ids (fail closed)', async () => {
    const { db } = makeFakeDb({
      ...noopHandlers,
      onSelect: (table) => {
        if (table !== 'kernel_module_activations') throw new Error(`unexpected select: ${table}`)
        return [{ active: true }]
      },
    })
    const store = new DbActivationStore(db)

    await expect(store.get('memory')).resolves.toBe(true)

    const empty = makeFakeDb(noopHandlers)
    await expect(new DbActivationStore(empty.db).get('memory')).resolves.toBe(false)
  })

  it('list returns a Map of module id to active flag', async () => {
    const { db } = makeFakeDb({
      ...noopHandlers,
      onSelect: () => [
        { moduleId: 'memory', active: true },
        { moduleId: 'email', active: false },
      ],
    })
    const listed = await new DbActivationStore(db).list()
    expect(listed).toBeInstanceOf(Map)
    expect(listed.get('memory')).toBe(true)
    expect(listed.get('email')).toBe(false)
  })
})

describe('DbPrincipalStore', () => {
  const row = {
    id: 'p1',
    kind: 'human' as const,
    displayName: 'Alex',
    roles: ['admin'],
    apiKeyHash: 'abc123',
  }

  it('getById maps the row to a Principal', async () => {
    const { db } = makeFakeDb({
      ...noopHandlers,
      onSelect: (table, query) => {
        if (table !== 'kernel_principals') throw new Error(`unexpected select: ${table}`)
        expect(query.limit).toBe(1)
        expect(query.where).toHaveLength(1)
        return [row]
      },
    })
    await expect(new DbPrincipalStore(db).getById('p1')).resolves.toEqual({
      id: 'p1',
      kind: 'human',
      displayName: 'Alex',
      roles: ['admin'],
      apiKeyHash: 'abc123',
    })
  })

  it('returns null when no row matches', async () => {
    const { db } = makeFakeDb(noopHandlers)
    await expect(new DbPrincipalStore(db).getByApiKey('missing')).resolves.toBeNull()
  })

  it('omits displayName when null', async () => {
    const { db } = makeFakeDb({
      ...noopHandlers,
      onSelect: () => [{ ...row, displayName: null, apiKeyHash: null }],
    })
    const principal = await new DbPrincipalStore(db).getById('p1')
    expect(principal).toEqual({ id: 'p1', kind: 'human', roles: ['admin'], apiKeyHash: null })
    expect('displayName' in (principal ?? {})).toBe(false)
  })
})

describe('DbApprovalStore', () => {
  const request = {
    id: 'a1',
    toolName: 'email.send_mail',
    input: { to: 'a@b.co' },
    principalId: 'p1',
    status: 'pending' as const,
  }

  it('create inserts and maps the returning row', async () => {
    const { db, calls } = makeFakeDb({
      ...noopHandlers,
      onInsert: (table, values) => {
        if (table !== 'kernel_approvals') throw new Error(`unexpected insert: ${table}`)
        return [{ ...values, decidedBy: null, decidedAt: null }]
      },
    })
    const created = await new DbApprovalStore(db).create(request)

    expect(created).toEqual(request)
    const call = calls[0]
    if (call.op !== 'insert') throw new Error('expected insert')
    expect(call.values).toMatchObject({
      id: 'a1',
      toolName: 'email.send_mail',
      principalId: 'p1',
      status: 'pending',
    })
  })

  it('decide updates with decidedBy/decidedAt and fails loud on unknown id', async () => {
    const { db } = makeFakeDb({
      ...noopHandlers,
      onUpdate: (_t, set) => [
        {
          ...request,
          status: 'approved',
          decidedBy: set.decidedBy,
          decidedAt: new Date('2026-09-07T12:00:00.000Z'),
        },
      ],
    })
    const decided = await new DbApprovalStore(db).decide('a1', 'approved', 'the-owner')
    expect(decided).toMatchObject({
      id: 'a1',
      status: 'approved',
      decidedBy: 'the-owner',
      decidedAt: '2026-09-07T12:00:00.000Z',
    })

    const empty = makeFakeDb(noopHandlers)
    await expect(
      new DbApprovalStore(empty.db).decide('missing', 'approved', 'the-owner'),
    ).rejects.toThrow(/unknown approval request/)
  })

  it('listPending selects pending rows ordered by createdAt', async () => {
    const { db } = makeFakeDb({
      ...noopHandlers,
      onSelect: (table, query) => {
        if (table !== 'kernel_approvals') throw new Error(`unexpected select: ${table}`)
        expect(query.where).toHaveLength(1)
        expect(query.orderBy).toHaveLength(1)
        return [
          { ...request, decidedBy: null, decidedAt: null },
          { ...request, id: 'a2', decidedBy: null, decidedAt: null },
        ]
      },
    })
    const pending = await new DbApprovalStore(db).listPending()
    expect(pending.map((r) => r.id)).toEqual(['a1', 'a2'])
  })

  it('latestFor takes the newest row limited to 1, or null', async () => {
    const { db } = makeFakeDb({
      ...noopHandlers,
      onSelect: (table, query) => {
        if (table !== 'kernel_approvals') throw new Error(`unexpected select: ${table}`)
        expect(query.limit).toBe(1)
        expect(query.orderBy).toHaveLength(1)
        // `and(eq(...), eq(...))` arrives as a single combined condition object.
        expect(query.where).toHaveLength(1)
        return [
          {
            ...request,
            status: 'approved' as const,
            decidedBy: 'the-owner',
            decidedAt: new Date('2026-09-07T12:00:00.000Z'),
          },
        ]
      },
    })
    const latest = await new DbApprovalStore(db).latestFor('email.send_mail', 'p1')
    expect(latest).toMatchObject({ status: 'approved', decidedAt: '2026-09-07T12:00:00.000Z' })

    const empty = makeFakeDb(noopHandlers)
    await expect(
      new DbApprovalStore(empty.db).latestFor('email.send_mail', 'p1'),
    ).resolves.toBeNull()
  })
})

describe('DbAgentSessionLog', () => {
  it('append inserts a user/assistant event with its payload', async () => {
    const { db, calls } = makeFakeDb(noopHandlers)
    const log = new DbAgentSessionLog(db)

    await log.append({
      sessionId: 'session-1',
      agentId: 'orchestrator',
      kind: 'user',
      payload: { text: 'hello' },
    })

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (call.op !== 'insert') throw new Error('expected insert')
    expect(call.table).toBe('kernel_agent_session_events')
    expect(call.values).toEqual({
      sessionId: 'session-1',
      agentId: 'orchestrator',
      kind: 'user',
      payload: { text: 'hello' },
    })
  })

  it('list maps rows back to events, newest-first query reversed to chronological order', async () => {
    const { db } = makeFakeDb({
      ...noopHandlers,
      onSelect: (table, query) => {
        if (table !== 'kernel_agent_session_events') {
          throw new Error(`unexpected select: ${table}`)
        }
        expect(query.where).toHaveLength(1)
        expect(query.orderBy).toHaveLength(1)
        expect(query.limit).toBe(2)
        // DESC by id — the store reverses to chronological before returning.
        return [
          {
            sessionId: 'session-1',
            agentId: 'orchestrator',
            kind: 'assistant',
            payload: { text: 'reply' },
          },
          {
            sessionId: 'session-1',
            agentId: 'orchestrator',
            kind: 'user',
            payload: { text: 'hello' },
          },
        ]
      },
    })

    await expect(new DbAgentSessionLog(db).list('session-1', 2)).resolves.toEqual([
      {
        sessionId: 'session-1',
        agentId: 'orchestrator',
        kind: 'user',
        payload: { text: 'hello' },
      },
      {
        sessionId: 'session-1',
        agentId: 'orchestrator',
        kind: 'assistant',
        payload: { text: 'reply' },
      },
    ])
  })

  it('list without a limit selects the full session unbounded', async () => {
    const { db } = makeFakeDb({
      ...noopHandlers,
      onSelect: (table, query) => {
        if (table !== 'kernel_agent_session_events') {
          throw new Error(`unexpected select: ${table}`)
        }
        expect(query.limit).toBeUndefined()
        return []
      },
    })

    await expect(new DbAgentSessionLog(db).list('session-1')).resolves.toEqual([])
  })

  it('accepts a lazy db provider resolved per operation', async () => {
    let resolved = 0
    const { db } = makeFakeDb(noopHandlers)
    const log = new DbAgentSessionLog(() => {
      resolved += 1
      return db
    })

    await log.append({
      sessionId: 'session-1',
      agentId: 'orchestrator',
      kind: 'assistant',
      payload: { text: 'hi' },
    })
    expect(resolved).toBe(1)
  })
})
