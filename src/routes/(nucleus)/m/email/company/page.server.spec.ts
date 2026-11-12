import { beforeEach, describe, expect, it, vi } from 'vitest'

const { settingsMock, listMock, requireAdminMock } = vi.hoisted(() => ({
  settingsMock: vi.fn(),
  listMock: vi.fn(),
  requireAdminMock: vi.fn(async () => ({ userId: 'u1', email: 'me@x.co' })),
}))
vi.mock('../access.server', () => ({ requireAdmin: requireAdminMock }))
vi.mock('../../../../../../modules/email/platform/service', () => ({
  emailPlatform: () => ({
    owlery: { settings: settingsMock },
    store: { listMessages: listMock },
  }),
}))

const { load } = await import('./+page.server')
const run = () => load({ locals: {} } as never) as Promise<Record<string, unknown>>

const row = (id: string, status: string) => ({
  id,
  toAddress: `${id}@x.co`,
  subject: `Subject ${id}`,
  status,
  source: 'api',
  scheduledAt: status === 'scheduled' ? new Date('2026-11-12T09:00:00Z') : null,
  createdAt: new Date('2026-11-11T09:00:00Z'),
})

describe('Email › Company mail (the company-wide pending + sent log; owner and admins)', () => {
  it('is for the owner and admins only: members get the admin refusal and nothing is read', async () => {
    requireAdminMock.mockRejectedValueOnce(Object.assign(new Error('Only the owner or an admin can change email settings.'), { status: 403 }))
    await expect(run()).rejects.toMatchObject({ status: 403 })
    expect(settingsMock).not.toHaveBeenCalled()
    expect(listMock).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    settingsMock.mockReset()
    listMock.mockReset()
  })

  it('without Amazon SES connected: no mail', async () => {
    settingsMock.mockResolvedValue(null)
    expect(await run()).toEqual({ connected: false, pending: [], sent: [] })
    expect(listMock).not.toHaveBeenCalled()
  })

  it('lists pending sends (scheduled, queued) apart from sent mail', async () => {
    settingsMock.mockResolvedValue({ region: 'eu-west-1' })
    listMock.mockImplementation(async (f: { statuses?: string[] }) =>
      f.statuses ? [row('p1', 'scheduled')] : [row('s1', 'delivered')],
    )
    const out = await run()
    expect(listMock).toHaveBeenCalledWith({ statuses: ['scheduled', 'queued'], limit: 10 })
    expect(listMock).toHaveBeenCalledWith({ excludeStatuses: ['scheduled', 'queued'], limit: 10 })
    expect(out).toEqual({
      connected: true,
      pending: [
        {
          id: 'p1',
          to: 'p1@x.co',
          subject: 'Subject p1',
          status: 'scheduled',
          source: 'api',
          scheduledAt: '2026-11-12T09:00:00.000Z',
          createdAt: '2026-11-11T09:00:00.000Z',
        },
      ],
      sent: [
        {
          id: 's1',
          to: 's1@x.co',
          subject: 'Subject s1',
          status: 'delivered',
          source: 'api',
          scheduledAt: null,
          createdAt: '2026-11-11T09:00:00.000Z',
        },
      ],
    })
  })
})
