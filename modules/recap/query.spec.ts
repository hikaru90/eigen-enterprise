import { describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { kernelGatewaySessions } from '$lib/server/db/gateway.schema'
import { kernelApprovals } from '$lib/server/db/kernel.schema'
import { kernelEvents } from '$lib/server/db/kernel.schema'
import {
  countPendingApprovals,
  listRecapWindowEvents,
  listTelegramOwnerChats,
} from './query'

/**
 * Minimal chainable drizzle fake: `.select().from(T).where().orderBy().limit()`
 * resolves to the rows mapped for table T. No real database involved.
 */
function fakeDb(tables: Map<unknown, unknown[]>): AppDatabase {
  const makeBuilder = () => {
    let table: unknown
    const builder = {
      from(t: unknown) {
        table = t
        return builder
      },
      where: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      then: (
        resolve: (rows: unknown[]) => unknown,
        reject: (err: unknown) => unknown,
      ): unknown => Promise.resolve(tables.get(table) ?? []).then(resolve, reject),
    }
    return builder
  }
  return {
    select: () => makeBuilder(),
  } as unknown as AppDatabase
}

const noopAllowlist = { list: async () => [] }

describe('listRecapWindowEvents', () => {
  it('maps rows to KernelEvents with ISO timestamps, oldest first', async () => {
    const rows = [
      {
        id: 'ev-2',
        ts: new Date('2026-09-09T06:00:00.000Z'),
        type: 'tool.executed',
        principalId: 'p1',
        source: 'urn:eigenenterprise:module:website',
        payload: { tool: 'website.create_page', ok: true },
      },
      {
        id: 'ev-1',
        ts: new Date('2026-09-09T05:00:00.000Z'),
        type: 'agent.replied',
        principalId: null,
        source: null,
        payload: { replyLength: 42 },
      },
    ]
    const db = fakeDb(new Map([[kernelEvents, rows]]))
    const events = await listRecapWindowEvents(db, {
      start: new Date('2026-09-08T06:00:00.000Z'),
      end: new Date('2026-09-09T06:00:00.000Z'),
    })
    expect(events.map((e) => e.id)).toEqual(['ev-1', 'ev-2'])
    expect(events[0].ts).toBe('2026-09-09T05:00:00.000Z')
    expect(events[0]).not.toHaveProperty('principalId')
    expect(events[1].principalId).toBe('p1')
  })

  it('resolves to an empty list with no rows', async () => {
    const db = fakeDb(new Map())
    const events = await listRecapWindowEvents(db, {
      start: new Date(0),
      end: new Date(1),
    })
    expect(events).toEqual([])
  })
})

describe('countPendingApprovals', () => {
  it('returns the pending count from the approvals table', async () => {
    const db = fakeDb(new Map([[kernelApprovals, [{ pending: 3 }]]]))
    await expect(countPendingApprovals(db)).resolves.toBe(3)
  })

  it('returns 0 when the table has no rows', async () => {
    const db = fakeDb(new Map())
    await expect(countPendingApprovals(db)).resolves.toBe(0)
  })
})

describe('listTelegramOwnerChats', () => {
  it('intersects telegram sessions with allowlisted principals (sorted, deduped)', async () => {
    const db = fakeDb(
      new Map([
        [
          kernelGatewaySessions,
          [
            { externalChatId: '200', principalId: 'p-owner' },
            { externalChatId: '100', principalId: 'p-owner' },
            { externalChatId: '300', principalId: 'p-gone' },
            { externalChatId: '400', principalId: 'p-admin' },
          ],
        ],
      ]),
    )
    const allowlist = {
      list: async () => [
        { platform: 'telegram', externalUserId: 'u1', principalId: 'p-owner' },
        { platform: 'telegram', externalUserId: 'u2', principalId: 'p-admin' },
        { platform: 'email', externalUserId: 'x', principalId: 'p-owner' },
      ],
    }
    await expect(listTelegramOwnerChats(db, allowlist)).resolves.toEqual(['100', '200', '400'])
  })

  it('returns no chats when the allowlist is empty (fail closed)', async () => {
    const db = fakeDb(
      new Map([[kernelGatewaySessions, [{ externalChatId: '200', principalId: 'p-owner' }]]]),
    )
    await expect(listTelegramOwnerChats(db, noopAllowlist)).resolves.toEqual([])
  })
})
