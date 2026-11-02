import { describe, expect, it, vi } from 'vitest'
import { load } from './+page.server'

const listKernelEventsMock = vi.hoisted(() => vi.fn(async () => []))

vi.mock('$lib/server/db', () => ({
  getDb: () => ({}) as never,
}))

vi.mock('$lib/server/activity/kernel-events', () => ({
  FEED_EVENT_TYPES: ['agent.dispatched', 'tool.executed'],
  listKernelEvents: listKernelEventsMock,
  toFeedItem: (event: unknown) => event,
}))

describe('activity page server', () => {
  it('redirects unauthenticated user', async () => {
    await expect(load({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 302 })
  })

  it('returns initial empty data', async () => {
    const data = await load({
      locals: { user: { id: 'u1', email: 'a@b.c' } },
      url: new URL('http://localhost/activity'),
    } as never)

    expect(data.calls).toEqual([])
    expect(data.totals).toEqual({
      baseCostUsd: '0.000000',
      markupUsd: '0.000000',
      totalCostUsd: '0.000000',
    })
    expect(data.overallTotals).toEqual({
      baseCostUsd: '0.000000',
      markupUsd: '0.000000',
      totalCostUsd: '0.000000',
    })
    expect(data.from).toBeNull()
    expect(data.to).toBeNull()
    expect(data.pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalCount: 0,
      totalPages: 1,
      hasPrev: false,
      hasNext: false,
    })
  })

  it('loads the company feed with the whitelisted event types and maps it render-ready', async () => {
    listKernelEventsMock.mockClear()
    listKernelEventsMock.mockResolvedValueOnce([
      { id: 'e1', ts: '2026-09-08T10:00:00.000Z', type: 'agent.dispatched' },
    ])

    const data = await load({
      locals: { user: { id: 'u1', email: 'a@b.c' } },
      url: new URL('http://localhost/activity'),
    } as never)

    expect(listKernelEventsMock).toHaveBeenCalledTimes(1)
    const [db, input] = listKernelEventsMock.mock.calls[0] as [unknown, { types: string[] }]
    expect(db).toBeDefined()
    expect(input.types).toEqual(['agent.dispatched', 'tool.executed'])
    expect(input.limit).toBeUndefined()
    expect(data.feed).toEqual([
      { id: 'e1', ts: '2026-09-08T10:00:00.000Z', type: 'agent.dispatched' },
    ])
  })
})
