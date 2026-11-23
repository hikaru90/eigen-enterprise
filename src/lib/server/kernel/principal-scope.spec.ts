import { AsyncLocalStorage } from 'node:async_hooks'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { coworkerPrincipal } from '$lib/kernel/principals'

const tenant = new AsyncLocalStorage<string>()
const appDb = new AsyncLocalStorage<object>()
const opened: string[] = []

vi.mock('$lib/server/db/tenant-context', () => ({ tenantUserAsyncLocal: tenant }))
vi.mock('$lib/server/db', () => ({
  appDbAsyncLocal: appDb,
  withDbUser: async <T>(userId: string, fn: () => Promise<T>) => {
    opened.push(userId)
    return tenant.run(userId, () => appDb.run({}, fn))
  },
}))

const { livePrincipalScope } = await import('./principal-scope')

/** The RLS scope of a tool call (CB3; AI co-workers: plan/phase-ai-coworkers.md §3). */
describe('livePrincipalScope', () => {
  beforeEach(() => {
    opened.length = 0
  })

  it('opens a person’s own session', async () => {
    await expect(livePrincipalScope({ id: 'ann', kind: 'human', roles: ['member'] }, async () => tenant.getStore())).resolves.toBe('ann')
    expect(opened).toEqual(['ann'])
  })

  it('scopes a co-worker by its own id, exactly like a person', async () => {
    const seen = await livePrincipalScope(coworkerPrincipal('cw_1', 'coworker:cw_1'), async () => tenant.getStore())
    expect(seen).toBe('cw_1')
    expect(opened).toEqual(['cw_1'])
  })

  it('never runs a co-worker inside a person’s session', async () => {
    const seen = await tenant.run('ann', () =>
      appDb.run({}, () => livePrincipalScope(coworkerPrincipal('cw_1', 'coworker:cw_1'), async () => tenant.getStore())),
    )
    expect(seen).toBe('cw_1')
    expect(opened).toEqual(['cw_1'])
  })

  it('reuses the co-worker’s own session when it already holds it', async () => {
    const seen = await tenant.run('cw_1', () =>
      appDb.run({}, () => livePrincipalScope(coworkerPrincipal('cw_1', 'coworker:cw_1'), async () => tenant.getStore())),
    )
    expect(seen).toBe('cw_1')
    expect(opened).toEqual([])
  })

  it('runs agents and services as called (company level)', async () => {
    await livePrincipalScope({ id: 'orchestrator', kind: 'agent', roles: ['agent'] }, async () => undefined)
    await livePrincipalScope({ id: 'system', kind: 'service', roles: ['admin'] }, async () => undefined)
    expect(opened).toEqual([])
  })
})
