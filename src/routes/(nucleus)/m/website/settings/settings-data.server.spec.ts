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

describe('website settings: the routing rows', () => {
  it('the calls host is "Calls", never a link to an app page that does not exist', async () => {
    status.current = { managed: true, ...ee }
    const data = await loadWebsiteSettings({ locals: { user: { id: 'u1' } } } as never)
    if (!data.managed) throw new Error('expected managed')
    expect(data.domains.map((d) => [d.host, d.role, d.owner.kind])).toEqual([
      ['one.eigenenterprise.app', 'Console', 'console'],
      ['kindred.digital', 'Site', 'site'],
      ['rtc.one.eigenenterprise.app', 'Calls', 'calls'],
      ['shop.kindred.digital', 'App', 'app'],
    ])
  })
})
