import { describe, expect, it, vi } from 'vitest'
import type { BoughtDomain } from '$lib/domains/contract'
import { syncBoughtDomains } from './mail-sync'

const d = (name: string, state: BoughtDomain['state']): BoughtDomain => ({ name, state, error: null, renewsAt: null, autoRenew: true })

function deps(domains: BoughtDomain[], mode: 'own' | 'managed' | null = 'managed') {
  const added = new Set<string>()
  return {
    added,
    list: vi.fn(async () => domains),
    mode: vi.fn(async () => mode),
    addBought: vi.fn(async (name: string) => {
      const fresh = !added.has(name)
      added.add(name)
      return { added: fresh }
    }),
  }
}

describe('syncBoughtDomains (managed-domains DM5)', () => {
  it('adds active domains only; not the ones still paying, registering, configuring, or failed', async () => {
    const x = deps([d('a.eu', 'charging'), d('b.eu', 'registering'), d('c.eu', 'configuring'), d('d.eu', 'active'), d('e.eu', 'failed')])
    expect(await syncBoughtDomains(x)).toEqual(['d.eu'])
    expect(x.addBought.mock.calls.map((c) => c[0])).toEqual(['d.eu'])
  })

  it('harmless when the control plane already made it a mail domain (configuring)', async () => {
    const x = deps([d('d.eu', 'active')])
    x.added.add('d.eu')
    expect(await syncBoughtDomains(x)).toEqual([])
    expect(x.addBought).toHaveBeenCalledOnce()
  })

  it('is idempotent: a second pass adds nothing new', async () => {
    const x = deps([d('d.eu', 'active')])
    await syncBoughtDomains(x)
    expect(await syncBoughtDomains(x)).toEqual([])
  })

  it('does nothing outside managed mode (own SES, or no email at all), without asking the control plane', async () => {
    for (const mode of ['own', null] as const) {
      const x = deps([d('d.eu', 'active')], mode)
      expect(await syncBoughtDomains(x)).toEqual([])
      expect(x.list).not.toHaveBeenCalled()
      expect(x.addBought).not.toHaveBeenCalled()
    }
  })

  it('a failed list fails loud (the tick logs it and retries)', async () => {
    const x = deps([])
    x.list.mockRejectedValueOnce(new Error('control plane down'))
    await expect(syncBoughtDomains(x)).rejects.toThrow('control plane down')
  })
})
