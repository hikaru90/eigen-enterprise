import { describe, expect, it, vi } from 'vitest'
import { actions, load } from './+page.server'

vi.mock('$lib/server/auth', () => ({
  auth: { api: { changeEmail: vi.fn() } },
}))
vi.mock('$lib/server/push/subscription', () => ({
  listPushDevicesForUser: vi.fn(async (userId: string) => [
    {
      id: 'd1',
      endpointHash: 'h',
      service: 'web.push.apple.com',
      userAgent: `ua of ${userId}`,
      since: '2026-11-01T08:00:00.000Z',
      lastSeen: '2026-11-20T08:00:00.000Z',
    },
  ]),
}))
vi.mock('$lib/server/profile/service', () => ({
  getProfile: vi.fn(async () => ({
    firstName: 'Ada',
    lastName: 'Lovelace',
    name: 'Ada Lovelace',
    email: 'a@b.c',
    image: '/api/people/avatar/' + 'a'.repeat(64),
    avatarSha256: 'a'.repeat(64),
    complete: true,
  })),
}))

describe('/settings — the Account section', () => {
  it('redirects unauthenticated load', async () => {
    await expect(load({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 302 })
  })

  it('loads the account, its profile and the person’s notification devices — nothing else (the other sections are their own pages)', async () => {
    const result = await load({ locals: { user: { id: 'u1', email: 'a@b.c' } } } as never)
    expect(result).toEqual({
      user: { id: 'u1', email: 'a@b.c' },
      profile: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        name: 'Ada Lovelace',
        email: 'a@b.c',
        image: '/api/people/avatar/' + 'a'.repeat(64),
        complete: true,
      },
      pushDevices: [
        {
          id: 'd1',
          endpointHash: 'h',
          service: 'web.push.apple.com',
          userAgent: 'ua of u1',
          since: '2026-11-01T08:00:00.000Z',
          lastSeen: '2026-11-20T08:00:00.000Z',
        },
      ],
    })
  })

  it('exposes only the email action — sign-in is passwordless, the password form is gone', () => {
    expect(Object.keys(actions)).toEqual(['changeEmail'])
  })

  it('returns 401 for unauthenticated account actions', async () => {
    const request = new Request('http://localhost/settings', {
      method: 'POST',
      body: new URLSearchParams({ newEmail: 'x@y.z' }),
    })
    const noUserEvent = { locals: { user: null }, request } as never
    expect(await actions.changeEmail(noUserEvent)).toMatchObject({ status: 401 })
  })

  it('changes the email through better-auth', async () => {
    const { auth } = await import('$lib/server/auth')
    const request = new Request('http://localhost/settings', {
      method: 'POST',
      body: new URLSearchParams({ newEmail: 'new@example.com' }),
    })
    const result = await actions.changeEmail({
      locals: { user: { id: 'u1' } },
      request,
    } as never)
    expect(vi.mocked(auth.api.changeEmail)).toHaveBeenCalledWith(
      expect.objectContaining({ body: { newEmail: 'new@example.com' } }),
    )
    expect(result).toMatchObject({ emailMessage: expect.stringContaining('email was updated') })
  })
})
