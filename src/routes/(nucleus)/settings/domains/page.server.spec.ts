import type { DomainsList } from '../../../../../modules/domains/view'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoughtDomain } from '$lib/domains/contract'
import { KernelRegistry } from '$lib/kernel/registry'
import { DomainsApiError } from '$lib/server/domains/client'
import { SubstrateError, type EeStatus } from '$lib/server/ee/client'
import { cachedResolver, type DnsResolver } from '../../../../../modules/domains/dns'
import { createDomainsTools, type DomainsEe } from '../../../../../modules/domains/tools'

const { roleMock, configMock, modeMock, holder } = vi.hoisted(() => ({
  roleMock: vi.fn(async (): Promise<string | null> => 'owner'),
  configMock: vi.fn(),
  modeMock: vi.fn(async (): Promise<'own' | 'managed' | null> => 'managed'),
  holder: { registry: null as unknown },
}))

vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))
vi.mock('$lib/server/domains/env', () => ({ domainsFromEnv: configMock }))
vi.mock('$lib/server/overview/sources', () => ({ foundingCompanyName: async () => 'Acme GmbH' }))
vi.mock('../../../../../modules/email/platform/service', () => ({
  emailPlatform: () => ({ owlery: { mode: modeMock } }),
}))
vi.mock('$lib/server/boot', () => ({ appKernel: async () => ({ registry: holder.registry }) }))
vi.mock('../../../../../modules/index', () => ({
  ensureSystemModulesActive: async () => undefined,
}))

import { actions, load } from './+page.server'

const BOX = '203.0.113.7'

class Ee implements DomainsEe {
  calls: Array<{ verb: string; input: unknown }> = []
  broken = false
  status_: EeStatus = {
    appliedRev: 'x',
    desiredRev: 'x',
    lastReconcileError: null,
    settings: {
      consoleHost: 'one.acme.eu',
      publicHost: 'acme.eu',
      acmeEmail: null,
      callsHost: 'rtc.one.acme.eu',
      rtcNodeIp: BOX,
    } as EeStatus['settings'],
    routes: [
      { host: 'one.acme.eu', workload: 'os' },
      { host: 'acme.eu', workload: 'os' },
      { host: 'rtc.one.acme.eu', workload: 'livekit' },
    ],
    certificates: [],
    claims: null,
    workloads: [],
    events: [],
  }
  async status() {
    if (this.broken) throw new SubstrateError(500, 'boom')
    return this.status_
  }
  async addDomain(i: Parameters<DomainsEe['addDomain']>[0]) {
    this.calls.push({ verb: 'addDomain', input: i })
    return { rev: 'r', reconcileError: null, replaced: null }
  }
  async removeDomain(i: { host: string; author: string }) {
    this.calls.push({ verb: 'removeDomain', input: i })
    return { rev: 'r', reconcileError: null }
  }
  async retryCertificate(host: string, author: string) {
    this.calls.push({ verb: 'retryCertificate', input: { host, author } })
    return { host, reloaded: true as const }
  }
}

/** DNS: every web host points at the box except shop.acme.eu (missing). */
const none = () => Promise.reject(Object.assign(new Error('nodata'), { code: 'ENODATA' }))
const dns: DnsResolver = {
  resolve4: async (n) => (n === 'shop.acme.eu' ? none() : [BOX]),
  resolve6: none,
  resolveCname: none,
  resolveTxt: none,
  resolveMx: none,
}

let ee: Ee
let bought: () => Promise<BoughtDomain[]>

function setup() {
  const registry = new KernelRegistry()
  for (const t of createDomainsTools({
    ee,
    mail: async () => [],
    bought: () => bought(),
    resolver: cachedResolver(dns, 60_000, () => 0),
  }))
    registry.register(t)
  holder.registry = registry
}

const user = { id: 'u1', email: 'ada@acme.test', name: 'Ada Lovelace' }
const event = (u: typeof user | null = user) =>
  ({ locals: { user: u } }) as unknown as Parameters<typeof load>[0]

function formEvent(fields: Record<string, string | string[]>) {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) body.append(k, one)
  }
  return { locals: { user }, request: new Request('http://x', { method: 'POST', body }) } as never
}

type ActionOut = { action: string; ok?: boolean; message?: string; error?: string; host?: string }
const outOf = (r: unknown) =>
  ((r as { data?: unknown })?.data ?? r) as ActionOut & { agent?: { tool?: string } }

describe('/settings/domains — on domains.list (owner and admins)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ee = new Ee()
    bought = async () => [
      {
        name: 'acme.eu',
        state: 'active',
        error: null,
        renewsAt: '2027-11-18T00:00:00.000Z',
        autoRenew: true,
      },
      { name: 'acme.shop', state: 'configuring', error: null, renewsAt: null, autoRenew: true },
    ]
    configMock.mockReturnValue({ base: 'https://cp.test', token: 't' })
    roleMock.mockResolvedValue('owner')
    setup()
  })

  it('signed out → login; a member → 403', async () => {
    await expect(load(event(null))).rejects.toMatchObject({ status: 302, location: '/login' })
    roleMock.mockResolvedValueOnce('member')
    await expect(load(event())).rejects.toMatchObject({ status: 403 })
  })

  it('every domain with its hostnames from domains.list; buying offered, registrant prefilled', async () => {
    const out = await load(event())
    expect(out).toMatchObject({
      canBuy: true,
      listError: null,
      registrant: { firstName: 'Ada', lastName: 'Lovelace', organization: 'Acme GmbH' },
    })
    const list = out.list as DomainsList
    expect(list.domains.map((d) => [d.name, d.source, d.hosts.map((h) => h.host)])).toEqual([
      ['acme.eu', 'bought', ['acme.eu', 'one.acme.eu', 'rtc.one.acme.eu']],
      ['acme.shop', 'bought', []],
    ])
    expect(out.mailNotes).toEqual({
      'acme.eu': 'Becoming a mail domain (within a minute).',
      'acme.shop': 'Becoming a mail domain (within a minute).',
    })
  })

  it('the control plane fails: the hostnames still show, its failure is one local notice', async () => {
    bought = async () => {
      throw new DomainsApiError(502, 'The domain service failed (HTTP 503).')
    }
    const out = await load(event())
    expect(out.listError).toBeNull()
    const list = out.list as DomainsList
    expect(list.domains.map((d) => d.name)).toEqual(['acme.eu'])
    expect(list.errors).toEqual([
      expect.objectContaining({ source: 'bought', error: 'The domain service failed (HTTP 503).' }),
    ])
  })

  it('domains.list itself fails (no public address on record): plain notice, buy/connect still offered', async () => {
    ee.status_ = {
      ...ee.status_,
      settings: { ...ee.status_.settings, rtcNodeIp: null } as EeStatus['settings'],
    }
    const out = await load(event())
    expect(out.list).toBeNull()
    expect(out.canBuy).toBe(true)
    expect(out.listError?.error).toMatch(/no public address on record/)
    expect(out.listError?.agent).toMatchObject({ tool: 'domains.list', code: 'not_configured' })
  })
})

describe('/settings/domains actions — each one the registry tool, answered in its words', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ee = new Ee()
    bought = async () => []
    configMock.mockReturnValue(null)
    roleMock.mockResolvedValue('owner')
    setup()
  })

  it('setTarget: domains.set_target as the person; the answer says what it showed before', async () => {
    const out = outOf(await actions.setTarget(formEvent({ host: 'acme.eu', shows: 'nothing' })))
    expect(out).toMatchObject({ ok: true, message: 'acme.eu no longer shows the company website.' })
    expect(ee.calls).toEqual([
      { verb: 'removeDomain', input: { host: 'acme.eu', author: 'human:u1' } },
    ])
  })

  it('addHost: the name under the domain + what it shows → domains.set_target', async () => {
    const out = outOf(
      await actions.addHost(formEvent({ domain: 'acme.eu', label: 'Shop', shows: 'app:shop' })),
    )
    expect(out).toMatchObject({
      ok: true,
      host: 'shop.acme.eu',
      message: 'shop.acme.eu now shows the app shop.',
    })
    expect(ee.calls[0]).toMatchObject({
      verb: 'addDomain',
      input: { host: 'shop.acme.eu', workload: 'shop' },
    })
  })

  it('a picker value that is no target is refused before any tool runs', async () => {
    const out = outOf(await actions.setTarget(formEvent({ host: 'acme.eu', shows: 'calls' })))
    expect(out.error).toBe('Choose what this address shows.')
    expect(ee.calls).toEqual([])
  })

  it('remove: domains.remove; the console cannot be removed, said plainly with agent instructions', async () => {
    const out = outOf(await actions.remove(formEvent({ host: 'one.acme.eu' })))
    expect(out.error).toMatch(/console/)
    expect(out.agent?.tool).toBe('domains.remove')
    expect(ee.calls).toEqual([])
  })

  it('recheck: every host under the domain looked up again, the result in one sentence', async () => {
    const out = outOf(
      await actions.recheck(formEvent({ domain: 'acme.eu', host: ['acme.eu', 'one.acme.eu'] })),
    )
    expect(out).toMatchObject({
      ok: true,
      message: 'Checked acme.eu again: every record is in place.',
    })
  })

  it('retryCertificate: domains.retry_certificate for that host', async () => {
    const out = outOf(await actions.retryCertificate(formEvent({ host: 'acme.eu' })))
    expect(out.message).toMatch(/Asked for a new certificate for acme.eu/)
    expect(ee.calls).toEqual([
      { verb: 'retryCertificate', input: { host: 'acme.eu', author: 'human:u1' } },
    ])
  })

  it('ee refuses: its plain sentence, never a silent failure', async () => {
    ee.broken = true
    const out = outOf(await actions.setTarget(formEvent({ host: 'acme.eu', shows: 'console' })))
    expect(out.error).toMatch(/deploy agent could not read the server status/)
  })
})
