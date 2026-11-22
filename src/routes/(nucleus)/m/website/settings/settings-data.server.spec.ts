import { describe, expect, it, vi } from 'vitest'
import type { EeStatus } from '$lib/server/ee/client'

const { status } = vi.hoisted(() => ({ status: { current: null as unknown } }))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: async (u: unknown) => u }))
vi.mock('$lib/server/website/owner-run', () => ({ ownerRun: async () => status.current }))

import { loadWebsiteSettings } from './settings-data.server'

const ee: EeStatus = {
  appliedRev: 'a',
  desiredRev: 'a',
  lastReconcileError: null,
  settings: {
    consoleHost: 'one.eigenenterprise.app',
    publicHost: 'kindred.digital',
    acmeEmail: null,
    callsHost: 'rtc.one.eigenenterprise.app',
  },
  routes: [
    { host: 'one.eigenenterprise.app', workload: 'os' },
    { host: 'kindred.digital', workload: 'os' },
    { host: 'rtc.one.eigenenterprise.app', workload: 'livekit' },
    { host: 'shop.kindred.digital', workload: 'shop' },
  ],
  certificates: [],
  claims: null,
  workloads: [],
  events: [],
}

describe('website settings: a summary of the addresses, edited in Settings › Domains', () => {
  it('counts what points at this server by what each shows (calls is "calls", never an app)', async () => {
    status.current = { managed: true, ...ee }
    const data = await loadWebsiteSettings({ locals: { user: { id: 'u1' } } } as never)
    if (!data.managed) throw new Error('expected managed')
    expect(data.domains).toEqual({ total: 4, console: 1, site: 1, apps: 1, calls: 1 })
  })
})
