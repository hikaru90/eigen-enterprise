import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KernelRegistry } from '$lib/kernel/registry'
import {
  EeClient,
  SubstrateUnavailableError,
  type EeStatus,
  type EeTransport,
} from '$lib/server/ee/client'
import { cachedResolver, type DnsResolver } from '../../../../../../modules/domains/dns'
import { createDomainsTools } from '../../../../../../modules/domains/tools'
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

import { load } from './+page.server'

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

/** DNS: every host points at the box. */
const none = () => Promise.reject(Object.assign(new Error('nodata'), { code: 'ENODATA' }))
const dns: DnsResolver = {
  resolve4: async () => ['203.0.113.7'],
  resolve6: none,
  resolveCname: none,
  resolveTxt: none,
  resolveMx: none,
}

type Call = { method: string; path: string; body?: unknown }

/** ee as a transport: records every call in order; `fail` makes one verb answer an error. */
function eeHarness(
  status: EeStatus,
  fail?: { method: string; path: string; status: number; detail: string },
) {
  const calls: Call[] = []
  const transport: EeTransport = async (method, path, body) => {
    calls.push({ method, path, body })
    if (fail && fail.method === method && fail.path === path) {
      return { status: fail.status, data: { detail: fail.detail } }
    }
    if (method === 'GET' && path === '/v1/status') return { status: 200, data: status }
    if (method === 'POST' && path === '/v1/domains') {
      const replaced =
        status.routes.find((r) => r.host === (body as { host: string }).host)?.workload ?? null
      return { status: 200, data: { rev: 'r1', reconcileError: null, replaced } }
    }
    return { status: 200, data: { rev: 'r1', reconcileError: null } }
  }
  return { calls, transport }
}

function register(registry: KernelRegistry, transport: EeTransport) {
  const ee = new EeClient(transport)
  for (const t of createSubstrateTools({ client: ee })) registry.register(t)
  for (const t of createDomainsTools({
    ee,
    mail: async () => [],
    bought: async () => [],
    resolver: cachedResolver(dns, 60_000, () => 0),
  }))
    registry.register(t)
}

function setup(transport: EeTransport) {
  const registry = new KernelRegistry()
  register(registry, transport)
  holder.registry = registry
}

const user = { id: 'owner-1' }
const event = { locals: { user } } as never

describe('/m/website/site load', () => {
  beforeEach(() => {
    holder.registry = null
  })

  it('with its own domain: the site lives at https://<publicHost>', async () => {
    const ee = eeHarness(
      eeStatus({
        settings: {
          consoleHost: 'os.ee.localhost',
          publicHost: 'kindred.digital',
          acmeEmail: null,
          rtcNodeIp: '203.0.113.7',
        } as EeStatus['settings'],
        routes: [
          { host: 'os.ee.localhost', workload: 'os' },
          { host: 'kindred.digital', workload: 'os' },
        ],
      }),
    )
    setup(ee.transport)

    const data = (await load(event)) as Record<string, unknown>
    expect(data).toEqual({
      managed: true,
      reason: null,
      publicHost: 'kindred.digital',
      siteUrl: 'https://kindred.digital',
      // Shown with its status; changed only in Settings › Domains.
      addresses: [{ host: 'kindred.digital', label: 'Live', on: true }],
      addressesError: null,
    })
  })

  it('the addresses cannot be read: the page still loads, the failure in plain words', async () => {
    // No public address on record: domains.list refuses (not_configured).
    const ee = eeHarness(eeStatus())
    setup(ee.transport)
    const data = (await load(event)) as Record<string, unknown>
    expect(data).toMatchObject({
      managed: true,
      siteUrl: 'https://os.ee.localhost',
      addresses: [],
      addressesError: {
        error: expect.stringMatching(/Settings › Domains/),
        agent: expect.objectContaining({ tool: 'domains.list', code: 'not_configured' }),
      },
    })
  })

  it('without a domain of its own: the site lives at the console address', async () => {
    const ee = eeHarness(eeStatus())
    setup(ee.transport)

    const data = (await load(event)) as Record<string, unknown>
    expect(data).toMatchObject({
      managed: true,
      publicHost: null,
      siteUrl: 'https://os.ee.localhost',
    })
  })

  it('not under ee: explicit unmanaged shape, no address invented', async () => {
    const transport: EeTransport = async () => {
      throw new SubstrateUnavailableError('ECONNREFUSED')
    }
    setup(transport)

    const data = (await load(event)) as Record<string, unknown>
    expect(data).toMatchObject({
      managed: false,
      reason: expect.stringMatching(/not running under ee/),
      publicHost: null,
      siteUrl: null,
    })
  })
})
