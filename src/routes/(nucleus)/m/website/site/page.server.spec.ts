import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KernelRegistry } from '$lib/kernel/registry'
import {
  EeClient,
  SubstrateUnavailableError,
  type EeStatus,
  type EeTransport,
} from '$lib/server/ee/client'
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

import { actions, load } from './+page.server'

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
      const replaced = status.routes.find((r) => r.host === (body as { host: string }).host)?.workload ?? null
      return { status: 200, data: { rev: 'r1', reconcileError: null, replaced } }
    }
    return { status: 200, data: { rev: 'r1', reconcileError: null } }
  }
  return { calls, transport }
}

function register(registry: KernelRegistry, transport: EeTransport) {
  const ee = new EeClient(transport)
  for (const t of createSubstrateTools({ client: ee })) registry.register(t)
  for (const t of createDomainsTools({ ee, mail: async () => [], bought: async () => [] })) registry.register(t)
}

function setup(transport: EeTransport) {
  const registry = new KernelRegistry()
  register(registry, transport)
  holder.registry = registry
}

const user = { id: 'owner-1' }
const event = { locals: { user } } as never

function formEvent(fields: Record<string, string>) {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.set(k, v)
  return { locals: { user }, request: new Request('http://x', { method: 'POST', body }) } as never
}

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
        },
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

describe('/m/website/site actions', () => {
  it('domainSet with no public host yet: exactly one call — add the host as the public site', async () => {
    const ee = eeHarness(eeStatus())
    setup(ee.transport)

    const out = (await actions.domainSet(formEvent({ host: 'Kindred.Digital' }))) as Record<
      string,
      unknown
    >
    expect(out).toMatchObject({
      action: 'domainSet',
      ok: true,
      host: 'kindred.digital',
      message: 'kindred.digital now shows the company website.',
    })
    expect(ee.calls).toEqual([
      { method: 'GET', path: '/v1/status' },
      { method: 'GET', path: '/v1/status' },
      {
        method: 'POST',
        path: '/v1/domains',
        body: { host: 'kindred.digital', role: 'public', workload: 'os', author: 'human:owner-1' },
      },
    ])
  })

  it('domainSet replaces the public host in a single atomic add; never deletes it first', async () => {
    const ee = eeHarness(
      eeStatus({
        settings: {
          consoleHost: 'os.ee.localhost',
          publicHost: 'old.kindred.digital',
          acmeEmail: null,
        },
      }),
    )
    setup(ee.transport)

    const out = (await actions.domainSet(formEvent({ host: 'kindred.digital' }))) as Record<
      string,
      unknown
    >
    expect(out).toMatchObject({
      action: 'domainSet',
      ok: true,
      host: 'kindred.digital',
      message: 'kindred.digital now shows the company website. old.kindred.digital no longer shows it.',
    })
    expect(ee.calls).toEqual([
      { method: 'GET', path: '/v1/status' },
      { method: 'GET', path: '/v1/status' },
      {
        method: 'POST',
        path: '/v1/domains',
        body: { host: 'kindred.digital', role: 'public', workload: 'os', author: 'human:owner-1' },
      },
    ])
  })

  const takenStatus = () =>
    eeStatus({
      settings: {
        consoleHost: 'os.ee.localhost',
        publicHost: 'old.kindred.digital',
        acmeEmail: null,
        callsHost: null,
      },
      routes: [
        { host: 'os.ee.localhost', workload: 'os' },
        { host: 'old.kindred.digital', workload: 'os' },
        { host: 'shop.kindred.digital', workload: 'shop' },
      ],
    })

  it.each([
    ['not a host', /valid domain/],
    ['os.ee.localhost', /^os\.ee\.localhost shows the console\. Give the console another address first/],
  ])('rejects %s without touching the existing domain', async (host, error) => {
    const ee = eeHarness(takenStatus())
    setup(ee.transport)
    const out = (await actions.domainSet(formEvent({ host }))) as {
      status: number
      data: { error: string }
    }
    expect(out.status).toBe(400)
    expect(out.data.error).toMatch(error)
    expect(ee.calls.filter((call) => call.method !== 'GET')).toEqual([])
  })

  it('a host that shows an app switches to the site, and says so (an ordinary change, never silent)', async () => {
    const ee = eeHarness(takenStatus())
    setup(ee.transport)
    const out = await actions.domainSet(formEvent({ host: 'shop.kindred.digital' }))
    expect(out).toMatchObject({
      ok: true,
      message:
        'shop.kindred.digital now shows the company website instead of the app shop. old.kindred.digital no longer shows it.',
    })
  })

  it('an ee rejection never removes the old public domain', async () => {
    const ee = eeHarness(
      eeStatus({
        settings: {
          consoleHost: 'os.ee.localhost',
          publicHost: 'old.kindred.digital',
          acmeEmail: null,
        },
      }),
      { method: 'POST', path: '/v1/domains', status: 409, detail: 'new domain rejected' },
    )
    setup(ee.transport)
    const out = (await actions.domainSet(formEvent({ host: 'new.kindred.digital' }))) as {
      status: number
      data: { error: string }
    }
    expect(out.status).toBe(400)
    expect(out.data.error).toBe(
      'The server did not point new.kindred.digital at the company website: new domain rejected.',
    )
    expect(ee.calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST'])
  })

  it('saving the current public domain is allowed', async () => {
    const ee = eeHarness(
      eeStatus({
        settings: {
          consoleHost: 'os.ee.localhost',
          publicHost: 'kindred.digital',
          acmeEmail: null,
        },
        routes: [{ host: 'kindred.digital', workload: 'os' }],
      }),
    )
    setup(ee.transport)
    const out = await actions.domainSet(formEvent({ host: 'kindred.digital' }))
    expect(out).toMatchObject({ ok: true, host: 'kindred.digital', message: 'kindred.digital already shows the company website.' })
    expect(ee.calls.map((call) => call.method)).toEqual(['GET', 'GET'])
  })

  it('domainRemove: removes exactly the host asked for, and says what it no longer shows', async () => {
    const ee = eeHarness(
      eeStatus({
        settings: { consoleHost: 'os.ee.localhost', publicHost: 'kindred.digital', acmeEmail: null, callsHost: null },
        routes: [
          { host: 'os.ee.localhost', workload: 'os' },
          { host: 'kindred.digital', workload: 'os' },
        ],
      }),
    )
    setup(ee.transport)

    const out = (await actions.domainRemove(formEvent({ host: 'kindred.digital' }))) as Record<
      string,
      unknown
    >
    expect(out).toMatchObject({
      action: 'domainRemove',
      ok: true,
      message: 'kindred.digital no longer shows the company website.',
    })
    expect(ee.calls).toEqual([
      { method: 'GET', path: '/v1/status' },
      {
        method: 'DELETE',
        path: '/v1/domains',
        body: { host: 'kindred.digital', author: 'human:owner-1' },
      },
    ])
  })

  it('ee refuses: its plain sentence is what the owner sees', async () => {
    const ee = eeHarness(eeStatus(), {
      method: 'POST',
      path: '/v1/domains',
      status: 409,
      detail: 'this host is already the console host',
    })
    setup(ee.transport)

    const out = (await actions.domainSet(formEvent({ host: 'x.example.com' }))) as {
      status: number
      data: { action: string; error: string }
    }
    expect(out.status).toBe(400)
    expect(out.data.action).toBe('domainSet')
    expect(out.data.error).toBe(
      'The server did not point x.example.com at the company website: this host is already the console host.',
    )
  })

  it('a malformed host is a plain sentence, not a schema dump', async () => {
    const ee = eeHarness(eeStatus())
    setup(ee.transport)

    const out = (await actions.domainSet(formEvent({ host: 'not a host' }))) as {
      status: number
      data: { error: string }
    }
    expect(out.status).toBe(400)
    expect(out.data.error).toMatch(/valid domain/i)
    expect(JSON.stringify(out.data.error)).not.toMatch(/regex|zod/i)
  })

  it('not under ee: the click fails with the plain console-stack reason and ee is never mutated', async () => {
    const registry = new KernelRegistry()
    const transport: EeTransport = async () => {
      throw new SubstrateUnavailableError('ECONNREFUSED')
    }
    register(registry, transport)
    holder.registry = registry

    const out = (await actions.domainSet(formEvent({ host: 'kindred.digital' }))) as {
      status: number
      data: { action: string; error: string }
    }
    expect(out.status).toBe(400)
    expect(out.data.action).toBe('domainSet')
    expect(out.data.error).toMatch(/without ee/)
  })
})
