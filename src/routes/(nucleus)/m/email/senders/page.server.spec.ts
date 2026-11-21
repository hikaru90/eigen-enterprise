import { beforeEach, describe, expect, it, vi } from 'vitest'

const { settingsMock, listSendersMock, listDomainsMock } = vi.hoisted(() => ({
  settingsMock: vi.fn(),
  listSendersMock: vi.fn(),
  listDomainsMock: vi.fn(),
}))
vi.mock('../access.server', () => ({
  requireMember: vi.fn(async () => ({ userId: 'u1', email: 'me@x.co', isAdmin: true })),
  requireAdmin: vi.fn(),
  act: vi.fn(),
  field: vi.fn(),
}))
vi.mock('../../../../../../modules/email/platform/service', () => ({
  emailPlatform: () => ({
    owlery: { settings: settingsMock },
    listSenders: listSendersMock,
    listDomains: listDomainsMock,
  }),
}))

const { load } = await import('./+page.server')
const run = () => load({ locals: {} } as never) as Promise<Record<string, unknown>>

describe('Email › Senders opens as soon as mail is connected, not once a default sender exists', () => {
  beforeEach(() => {
    settingsMock.mockReset()
    listSendersMock.mockReset()
    listDomainsMock.mockReset()
  })

  it('no mail at all (neither own SES nor eigenEnterprise Mail): not connected, nothing read', async () => {
    settingsMock.mockResolvedValue(null)
    expect(await run()).toEqual({ connected: false, senders: [], domains: [] })
    expect(listSendersMock).not.toHaveBeenCalled()
  })

  it('eigenEnterprise Mail with a verified domain and no sender yet: connected, the domain offered for the first sender', async () => {
    settingsMock.mockResolvedValue({ mode: 'managed', emailFrom: '' })
    listSendersMock.mockResolvedValue([])
    listDomainsMock.mockResolvedValue([
      { name: 'acme.test', sendable: true },
      { name: 'pending.test', sendable: false },
    ])
    expect(await run()).toEqual({ connected: true, senders: [], domains: ['acme.test'] })
  })

  it('lists the senders with the default marked', async () => {
    settingsMock.mockResolvedValue({ mode: 'own', emailFrom: 'hello@acme.test' })
    listSendersMock.mockResolvedValue([
      {
        id: 's1',
        address: 'hello@acme.test',
        displayName: 'Acme',
        domainName: 'acme.test',
        isDefault: true,
      },
    ])
    listDomainsMock.mockResolvedValue([{ name: 'acme.test', sendable: true }])
    expect(await run()).toEqual({
      connected: true,
      senders: [
        {
          id: 's1',
          address: 'hello@acme.test',
          displayName: 'Acme',
          domainName: 'acme.test',
          isDefault: true,
        },
      ],
      domains: ['acme.test'],
    })
  })
})
