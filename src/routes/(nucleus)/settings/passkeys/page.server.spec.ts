import { describe, expect, it, vi } from 'vitest'
import { load } from './+page.server'

const { listPasskeys, listSessions } = vi.hoisted(() => ({
  listPasskeys: vi.fn(),
  listSessions: vi.fn(),
}))
vi.mock('$lib/server/auth', () => ({ auth: { api: { listPasskeys, listSessions } } }))

const event = (user: { id: string } | null) =>
  ({
    locals: { user, session: { id: 's-here' } },
    url: new URL('http://localhost:4173/settings/passkeys'),
    request: new Request('http://localhost:4173/settings/passkeys'),
  }) as unknown as Parameters<typeof load>[0]

describe('/settings/passkeys — Passkeys & sessions', () => {
  it('redirects signed-out visitors to login', async () => {
    await expect(load(event(null))).rejects.toMatchObject({ status: 302 })
  })

  it('lists passkeys and sessions on the server — the page never waits on a client query', async () => {
    listPasskeys.mockResolvedValueOnce([
      {
        id: 'pk1',
        name: null,
        deviceType: 'singleDevice',
        backedUp: false,
        createdAt: new Date('2026-11-01T10:00:00Z'),
      },
    ])
    listSessions.mockResolvedValueOnce([
      {
        id: 's-here',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        ipAddress: '127.0.0.1',
        createdAt: new Date('2026-11-02T09:00:00Z'),
        updatedAt: new Date('2026-11-02T09:30:00Z'),
      },
      {
        id: 's-other',
        userAgent: null,
        ipAddress: null,
        createdAt: new Date('2026-10-30T09:00:00Z'),
        updatedAt: new Date('2026-10-30T09:00:00Z'),
      },
    ])
    expect(await load(event({ id: 'u1' }))).toEqual({
      origin: 'http://localhost:4173',
      passkeys: [
        {
          id: 'pk1',
          name: 'Passkey',
          syncs: false,
          backedUp: false,
          createdAt: '2026-11-01T10:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 's-here',
          current: true,
          device: 'Chrome on macOS',
          ipAddress: '127.0.0.1',
          signedInAt: '2026-11-02T09:00:00.000Z',
          lastActive: '2026-11-02T09:30:00.000Z',
        },
        {
          id: 's-other',
          current: false,
          device: null,
          ipAddress: null,
          signedInAt: '2026-10-30T09:00:00.000Z',
          lastActive: '2026-10-30T09:00:00.000Z',
        },
      ],
    })
  })

  it('lets a failing list fail loud (error page), never an endless "Loading…"', async () => {
    listPasskeys.mockRejectedValueOnce(new Error('db down'))
    listSessions.mockResolvedValueOnce([])
    await expect(load(event({ id: 'u1' }))).rejects.toThrow('db down')
  })
})
