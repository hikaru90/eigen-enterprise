import { describe, expect, it, vi } from 'vitest'
import { load } from './+page.server'

const listKernelEventsMock = vi.hoisted(() => vi.fn(async () => []))

vi.mock('$lib/server/db', () => ({
  getDb: () => ({}) as never,
}))

vi.mock('$lib/server/activity/kernel-events', () => ({
  FEED_EVENT_TYPES: ['agent.dispatched', 'tool.executed'],
  listKernelEvents: listKernelEventsMock,
}))

vi.mock('$lib/server/boot', () => ({
  appKernel: async () => ({
    modules: {
      list: () => [{ name: 'Website', toolNamespaces: ['website', 'substrate', 'github'] }],
    },
  }),
}))

vi.mock('../../../../../modules/orchestrator/brain', () => ({
  ORCHESTRATOR_AGENT_ID: 'orchestrator',
}))

describe('activity page server', () => {
  it('redirects unauthenticated user', async () => {
    await expect(load({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 302 })
  })

  it('returns initial empty data', async () => {
    const data = await load({
      locals: { user: { id: 'u1', email: 'a@b.c' } },
      url: new URL('http://localhost/assistant/activity'),
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

  it('loads the whitelisted events as a readable log grouped by day, filterable by module', async () => {
    listKernelEventsMock.mockClear()
    const events = [
      {
        id: 'e2',
        ts: '2026-09-08T10:01:00.000Z',
        type: 'tool.executed',
        principalId: 'orchestrator',
        source: 'urn:eigenenterprise:module:website',
        payload: { tool: 'website.list_pages', ok: true },
      },
      {
        id: 'e1',
        ts: '2026-09-08T10:00:00.000Z',
        type: 'agent.dispatched',
        principalId: 'orchestrator',
        payload: {},
      },
    ]
    listKernelEventsMock.mockResolvedValue(events as never)

    const data = await load({
      locals: { user: { id: 'u1', email: 'a@b.c' } },
      url: new URL('http://localhost/assistant/activity'),
    } as never)

    const [db, input] = listKernelEventsMock.mock.calls[0] as unknown as [
      unknown,
      { types: string[] },
    ]
    expect(db).toBeDefined()
    expect(input.types).toEqual(['agent.dispatched', 'tool.executed'])
    expect(data.log).toHaveLength(1)
    expect(data.log[0].day).toBe('2026-09-08')
    expect(data.log[0].entries.map((e) => e.text)).toEqual([
      'Used Website: list pages',
      'Started working on a conversation',
    ])
    expect(data.modules).toEqual([
      { id: 'agent', label: 'Agent' },
      { id: 'website', label: 'Website' },
    ])
    expect(JSON.stringify(data)).not.toContain('principalId')

    const filtered = await load({
      locals: { user: { id: 'u1', email: 'a@b.c' } },
      url: new URL('http://localhost/assistant/activity?module=website'),
    } as never)
    expect(filtered.module).toBe('website')
    expect(filtered.log[0].entries.map((e) => e.id)).toEqual(['e2'])
    listKernelEventsMock.mockResolvedValue([])
  })
})
