import { describe, expect, it, vi } from 'vitest'
import { KernelRegistry } from '$lib/kernel/registry'
import {
  EeClient,
  SubstrateUnavailableError,
  type EeStatus,
  type EeTransport,
} from '$lib/server/ee/client'
import { createSubstrateTools } from '../../../../../../modules/website/hosting/tools'

const { holder } = vi.hoisted(() => ({ holder: { registry: null as unknown } }))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: async (u: unknown) => u }))
vi.mock('$lib/server/boot', async () => {
  const index = await import('../../../../../../modules/index')
  return { appKernel: async () => index.bootstrapKernel() }
})
vi.mock('../../../../../../modules/index', () => ({
  bootstrapKernel: () => ({ registry: holder.registry }),
  ensureSystemModulesActive: async () => undefined,
}))

import { load as settingsLoad } from '../settings/+page.server'
import { load as hostingLoad } from './+page.server'

function eeStatus(overrides: Partial<EeStatus> = {}): EeStatus {
  return {
    appliedRev: 'a'.repeat(40),
    desiredRev: 'b'.repeat(40),
    lastReconcileError: null,
    settings: { consoleHost: 'os.ee.localhost', publicHost: null, acmeEmail: null },
    routes: [{ host: 'os.ee.localhost', workload: 'os' }],
    workloads: [],
    events: [],
    ...overrides,
  }
}

/**
 * ee as a transport: answers GET /v1/status from the given status and refuses
 * anything else — the hosting page is read-only, so a mutation would fail the
 * spec by falling off the stub.
 */
function setup(status: EeStatus) {
  const transport: EeTransport = async (method, path) => {
    if (method === 'GET' && path === '/v1/status') return { status: 200, data: status }
    throw new Error(`hosting load must not call ee: ${method} ${path}`)
  }
  const registry = new KernelRegistry()
  for (const t of createSubstrateTools({ client: new EeClient(transport) })) registry.register(t)
  holder.registry = registry
}

const user = { id: 'owner-1' }
const event = { locals: { user } } as never

describe.each([
  ['/m/website/hosting', hostingLoad],
  ['/m/website/settings', settingsLoad],
] as const)('%s', (_route, load) => {
  it('not under ee: the explicit unmanaged shape carries the reason', async () => {
    const transport: EeTransport = async () => {
      throw new SubstrateUnavailableError('ECONNREFUSED')
    }
    const registry = new KernelRegistry()
    for (const t of createSubstrateTools({ client: new EeClient(transport) })) registry.register(t)
    holder.registry = registry

    const data = (await load(event)) as { managed: boolean; reason: string }
    expect(data.managed).toBe(false)
    expect(data.reason).toMatch(/not running under ee/)
  })

  it('maps every domain to its structural role: the console host, the site host, otherwise the workload', async () => {
    setup(
      eeStatus({
        settings: {
          consoleHost: 'os.ee.localhost',
          publicHost: 'kindred.digital',
          acmeEmail: null,
        },
        routes: [
          { host: 'os.ee.localhost', workload: 'os' },
          { host: 'kindred.digital', workload: 'os' },
          { host: 'shop.kindred.digital', workload: 'shop' },
        ],
        lastReconcileError: 'caddy did not reload',
      }),
    )
    const data = (await load(event)) as Record<string, unknown>

    expect(data).toEqual({
      managed: true,
      server: {
        consoleHost: 'os.ee.localhost',
        consoleUrl: 'https://os.ee.localhost',
        siteHost: 'kindred.digital',
        appliedRev: 'a'.repeat(40),
        desiredRev: 'b'.repeat(40),
        lastReconcileError: 'caddy did not reload',
      },
      domains: [
        {
          host: 'os.ee.localhost',
          url: 'https://os.ee.localhost',
          role: 'Console',
          owner: { kind: 'console' },
        },
        {
          host: 'kindred.digital',
          url: 'https://kindred.digital',
          role: 'Site',
          owner: { kind: 'site', href: '/m/website/site' },
        },
        {
          host: 'shop.kindred.digital',
          url: 'https://shop.kindred.digital',
          role: 'App',
          owner: { kind: 'app', name: 'shop', href: '/m/website/apps/shop' },
        },
      ],
    })
  })

  it('no public host yet: the site row is absent and the server says so', async () => {
    setup(
      eeStatus({
        routes: [
          { host: 'os.ee.localhost', workload: 'os' },
          { host: 'api.acme.dev', workload: 'api' },
        ],
      }),
    )
    const data = (await load(event)) as {
      server: { siteHost: string | null }
      domains: Array<{ host: string; role: string }>
    }
    expect(data.server.siteHost).toBeNull()
    expect(data.domains.map((d) => [d.host, d.role])).toEqual([
      ['os.ee.localhost', 'Console'],
      ['api.acme.dev', 'App'],
    ])
  })
})
