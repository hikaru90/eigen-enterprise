import { describe, expect, it, vi } from 'vitest'
import { actions, load } from './+page.server'

const { getDbMock, isUserProviderReadyMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  isUserProviderReadyMock: vi.fn(),
}))
vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/llm/provider-ready', () => ({
  isUserProviderReady: isUserProviderReadyMock,
}))
vi.mock('$lib/server/auth', () => ({
  auth: { api: { changeEmail: vi.fn(), changePassword: vi.fn() } },
}))

describe('settings page server (minimal Eigen Enterprise settings)', () => {
  it('redirects unauthenticated load', async () => {
    await expect(load({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 302 })
  })

  it('loads the account plus provider readiness — nothing else', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    const result = await load({ locals: { user: { id: 'u1', email: 'a@b.c' } } } as never)
    expect(result).toEqual({
      user: { id: 'u1', email: 'a@b.c' },
      providerReady: true,
    })
  })

  it('exposes exactly the account actions — eigen feature actions are gone', () => {
    expect(Object.keys(actions).sort()).toEqual(['changeEmail', 'changePassword'])
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

  it('rejects short passwords loudly', async () => {
    const request = new Request('http://localhost/settings', {
      method: 'POST',
      body: new URLSearchParams({ currentPassword: 'cur', newPassword: 'short' }),
    })
    const result = await actions.changePassword({
      locals: { user: { id: 'u1' } },
      request,
    } as never)
    expect(result).toMatchObject({ status: 400 })
  })

  it('changes the password through better-auth', async () => {
    const { auth } = await import('$lib/server/auth')
    const request = new Request('http://localhost/settings', {
      method: 'POST',
      body: new URLSearchParams({ currentPassword: 'current-pw', newPassword: 'new-password-1' }),
    })
    const result = await actions.changePassword({
      locals: { user: { id: 'u1' } },
      request,
    } as never)
    expect(vi.mocked(auth.api.changePassword)).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          currentPassword: 'current-pw',
          newPassword: 'new-password-1',
          revokeOtherSessions: false,
        },
      }),
    )
    expect(result).toMatchObject({ passwordMessage: 'Password updated successfully.' })
  })
})
