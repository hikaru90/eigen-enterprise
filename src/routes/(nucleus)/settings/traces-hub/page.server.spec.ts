import { describe, expect, it, vi } from 'vitest'

const { active, stats } = vi.hoisted(() => ({ active: { on: false }, stats: vi.fn(async () => [{ key: 'memory.list_tasks', spans: 3, errors: 1, errorRate: 0.3333, installs: 2, p50Ms: 10, p95Ms: 40, tokensIn: 0, tokensOut: 0, costUsd: 0 }]) }))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: async () => 'owner' }))
vi.mock('../../../../../modules/traces/hub/live', () => ({
  traceHubActive: async () => active.on,
  traceHubReadDeps: async () => ({ store: { stats }, now: () => Date.parse('2026-11-21T00:00:00Z') }),
}))

import { load } from './+page.server'

const ev = (search = '') => ({ locals: { user: { id: 'u1' } }, url: new URL(`http://x/settings/traces-hub${search}`) })

describe('the product signals hub page (plan/traces-phone-home.md T4)', () => {
  it('is a 404 where the trace-hub module is off', async () => {
    active.on = false
    await expect(load(ev() as never)).rejects.toMatchObject({ status: 404 })
  })

  it('shows error rate and p95 grouped by the chosen dimension (tool by default)', async () => {
    active.on = true
    const data = (await load(ev('?by=model') as never)) as { groupBy: string; rows: unknown[] }
    expect(data.groupBy).toBe('model')
    expect(stats).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'model', fromDay: '2026-10-23', toDay: '2026-11-21' }))
    expect(data.rows).toHaveLength(1)
    expect(((await load(ev('?by=nonsense') as never)) as { groupBy: string }).groupBy).toBe('tool')
  })
})
