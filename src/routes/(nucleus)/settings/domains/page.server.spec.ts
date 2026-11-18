import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeControlPlane } from '$lib/server/domains/fake-control-plane'

const { roleMock, configMock, listDomainsMock, modeMock, cp } = vi.hoisted(() => ({
  roleMock: vi.fn(async (): Promise<string | null> => 'owner'),
  configMock: vi.fn(),
  listDomainsMock: vi.fn(async () => [] as unknown[]),
  modeMock: vi.fn(async (): Promise<'own' | 'managed' | null> => 'managed'),
  cp: { current: null as null | { fetch: typeof fetch } },
}))

vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))
vi.mock('$lib/server/domains/env', () => ({ domainsFromEnv: configMock }))
vi.mock('$lib/server/overview/sources', () => ({ foundingCompanyName: async () => 'Acme GmbH' }))
vi.mock('../../../../../modules/email/platform/service', () => ({
  emailPlatform: () => ({ listDomains: listDomainsMock, owlery: { mode: modeMock } }),
}))
vi.mock('$lib/server/domains/client', async (orig) => {
  const real = await orig<typeof import('$lib/server/domains/client')>()
  return { ...real, domainsClient: (config: never) => real.domainsClient(config, cp.current!.fetch) }
})

import { load } from './+page.server'

const event = (user: { id: string; email: string; name?: string } | null) =>
  ({ locals: { user } }) as unknown as Parameters<typeof load>[0]

describe('/settings/domains — the company’s domains (owner and admins)', () => {
  let fake: FakeControlPlane
  beforeEach(() => {
    vi.clearAllMocks()
    fake = new FakeControlPlane()
    cp.current = fake
    configMock.mockReturnValue(fake.config())
    roleMock.mockResolvedValue('owner')
  })

  it('signed out → login; a member → 403', async () => {
    await expect(load(event(null))).rejects.toMatchObject({ status: 302, location: '/login' })
    roleMock.mockResolvedValueOnce('member')
    await expect(load(event({ id: 'm', email: 'm@acme.test' }))).rejects.toMatchObject({ status: 403 })
  })

  it('lists bought and connected domains, offers buying with the registrant prefilled', async () => {
    fake.domains = [{ name: 'acme.eu', state: 'active', error: null, renewsAt: '2027-11-18T00:00:00.000Z', autoRenew: true }]
    listDomainsMock.mockResolvedValue([
      { id: 'd1', name: 'acme.eu', status: 'SUCCESS', sendable: true, receiving: true, records: [] },
      { id: 'd2', name: 'acme.test', status: 'PENDING', sendable: false, receiving: false, records: [] },
    ])
    const out = await load(event({ id: 'u1', email: 'ada@acme.test', name: 'Ada Lovelace' }))
    expect(out).toMatchObject({
      canBuy: true,
      boughtError: null,
      registrant: { firstName: 'Ada', lastName: 'Lovelace', organization: 'Acme GmbH', email: 'ada@acme.test' },
    })
    expect(out.rows.map((r) => [r.name, r.source, r.mail?.id])).toEqual([
      ['acme.eu', 'bought', 'd1'],
      ['acme.test', 'connected', 'd2'],
    ])
    expect(JSON.stringify(out)).not.toContain(fake.token)
  })

  it('self-hosted: no buying, no control plane call, connected domains still listed', async () => {
    configMock.mockReturnValue(null)
    listDomainsMock.mockResolvedValue([{ id: 'd2', name: 'acme.test', status: 'SUCCESS', sendable: true, receiving: false, records: [] }])
    const out = await load(event({ id: 'u1', email: 'ada@acme.test' }))
    expect(out).toMatchObject({ canBuy: false, registrant: null, boughtError: null })
    expect(out.rows).toHaveLength(1)
    expect(fake.seenAuth).toEqual([])
  })

  it('a control plane outage shows in plain words; the page still loads', async () => {
    fake.broken = { status: 503, body: null }
    const out = await load(event({ id: 'u1', email: 'ada@acme.test' }))
    expect(out.boughtError).toMatch(/HTTP 503/)
  })
})
