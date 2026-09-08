import type { KernelEvent } from '$lib/kernel/events'
import { describe, expect, it } from 'vitest'
import {
  FEED_EVENT_TYPES,
  FEED_PAYLOAD_FIELDS,
  listKernelEvents,
  toFeedItem,
  type ActivityFeedItem,
} from './kernel-events'

type Row = {
  id: string
  ts: Date
  type: string
  principalId: string | null
  source: string | null
  payload: unknown
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'e1',
    ts: new Date('2026-09-08T10:00:00.000Z'),
    type: 'agent.dispatched',
    principalId: 'orchestrator',
    source: 'urn:eigenenterprise:kernel',
    payload: {},
    ...overrides,
  }
}

/** Minimal fake of the drizzle chain listKernelEvents uses; captures the query shape. */
function makeDb(rows: Row[]) {
  const calls = {
    selection: [] as string[][],
    where: [] as unknown[],
    order: [] as unknown[],
    limit: [] as number[],
  }
  const db = {
    select: (selection: Record<string, unknown>) => {
      calls.selection.push(Object.keys(selection))
      return {
        from: () => ({
          where: (condition: unknown) => {
            calls.where.push(condition)
            return {
              orderBy: (order: unknown) => {
                calls.order.push(order)
                return {
                  limit: (n: number) => {
                    calls.limit.push(n)
                    return Promise.resolve(rows)
                  },
                }
              },
            }
          },
        }),
      }
    },
  }
  return { db: db as never, calls }
}

describe('listKernelEvents', () => {
  it('maps rows to KernelEvent shape (ISO ts, null principalId/source omitted)', async () => {
    const rows = [
      row({
        id: 'e2',
        ts: new Date('2026-09-08T10:01:00.000Z'),
        type: 'agent.replied',
        payload: { agentId: 'orchestrator', sessionId: 's1', replyLength: 12 },
      }),
      row({ id: 'e1', principalId: null, source: null }),
    ]
    const { db } = makeDb(rows)

    const events = await listKernelEvents(db)

    expect(events).toEqual([
      {
        id: 'e2',
        ts: '2026-09-08T10:01:00.000Z',
        type: 'agent.replied',
        principalId: 'orchestrator',
        source: 'urn:eigenenterprise:kernel',
        payload: { agentId: 'orchestrator', sessionId: 's1', replyLength: 12 },
      },
      { id: 'e1', ts: '2026-09-08T10:00:00.000Z', type: 'agent.dispatched', payload: {} },
    ])
  })

  it('queries only the feed columns, orders newest-first, defaults limit 50', async () => {
    const { db, calls } = makeDb([])

    await listKernelEvents(db, { types: [...FEED_EVENT_TYPES] })

    expect(calls.selection).toEqual([['id', 'ts', 'type', 'principalId', 'source', 'payload']])
    expect(calls.where).toHaveLength(1)
    expect(calls.where[0]).toBeDefined()
    expect(calls.order).toHaveLength(1)
    expect(calls.limit).toEqual([50])
  })

  it('applies a custom limit and the before cursor', async () => {
    const { db, calls } = makeDb([])

    await listKernelEvents(db, {
      types: ['tool.executed'],
      limit: 5,
      before: new Date('2026-09-08T00:00:00.000Z'),
    })

    expect(calls.limit).toEqual([5])
    expect(calls.where).toHaveLength(1)
    expect(calls.where[0]).toBeDefined()
  })

  it('queries unfiltered when no types are passed', async () => {
    const { db, calls } = makeDb([])

    await listKernelEvents(db, { limit: 1 })

    expect(calls.where).toEqual([undefined])
    expect(calls.limit).toEqual([1])
  })

  it('fails loud on an unknown event type (exact-match whitelist, no heuristics)', async () => {
    const { db } = makeDb([])

    await expect(
      listKernelEvents(db, { types: ['gateway.slack.message'] }),
    ).rejects.toThrowError()
  })

  it('fails loud on an empty types array, a zero limit, and a non-integer limit', async () => {
    const { db } = makeDb([])

    await expect(listKernelEvents(db, { types: [] })).rejects.toThrowError()
    await expect(listKernelEvents(db, { limit: 0 })).rejects.toThrowError()
    await expect(listKernelEvents(db, { limit: 1.5 })).rejects.toThrowError()
  })
})

describe('toFeedItem', () => {
  const base: KernelEvent = {
    id: 'e1',
    ts: '2026-09-08T10:00:05.000Z',
    type: 'tool.executed',
    principalId: 'orchestrator',
    payload: {},
  }

  it('renders only whitelisted payload fields and drops everything else', () => {
    const item = toFeedItem({
      ...base,
      payload: {
        tool: 'agent.list',
        auditClass: 'read',
        ok: true,
        durationMs: 12,
        error: 'SECRET-ERROR-DETAIL',
        input: 'SECRET-INPUT',
      },
    })

    expect(item.summary).toBe('tool=agent.list auditClass=read ok=true durationMs=12')
    expect(item.summary).not.toContain('SECRET')
  })

  it('never carries message/reply content — metadata fields only', () => {
    const message = toFeedItem({
      ...base,
      type: 'gateway.telegram.message',
      payload: { chatId: 'chat-1', principalId: 'p1', textLength: 42, text: 'SECRET TEXT' },
    })
    expect(message.summary).toBe('')

    const replied = toFeedItem({
      ...base,
      type: 'agent.replied',
      payload: { agentId: 'orchestrator', sessionId: 's1', replyLength: 7, reply: 'SECRET REPLY' },
    })
    expect(replied.summary).toBe('replyLength=7 agentId=orchestrator sessionId=s1')
    expect(replied.summary).not.toContain('SECRET')
  })

  it('projects id, server-formatted UTC timestamp, type, and principal', () => {
    const item: ActivityFeedItem = toFeedItem(base)

    expect(item).toEqual({
      id: 'e1',
      tsLabel: '2026-09-08 10:00:05 UTC',
      type: 'tool.executed',
      principalId: 'orchestrator',
      summary: '',
    })
  })

  it('omits principalId when absent and tolerates non-object payloads', () => {
    const noPrincipal = toFeedItem({ ...base, principalId: undefined, payload: { runId: 'r1' } })
    expect(noPrincipal.principalId).toBeUndefined()
    expect(noPrincipal.summary).toBe('runId=r1')

    for (const payload of [null, 'text', 42, ['array']]) {
      expect(toFeedItem({ ...base, payload }).summary).toBe('')
    }
  })

  it('fails loud on an invalid ts instead of rendering garbage', () => {
    expect(() => toFeedItem({ ...base, ts: 'not-a-date' })).toThrowError(/invalid event timestamp/)
  })

  it('exposes the payload whitelist used for rendering', () => {
    expect(FEED_PAYLOAD_FIELDS).toEqual([
      'tool',
      'auditClass',
      'ok',
      'durationMs',
      'replyLength',
      'agentId',
      'sessionId',
      'runId',
      'green',
    ])
  })
})
