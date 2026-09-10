import { beforeEach, describe, expect, it, vi } from 'vitest'

const { activateMock, requireAdminMock } = vi.hoisted(() => ({
  activateMock: vi.fn(),
  requireAdminMock: vi.fn(),
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: requireAdminMock }))
vi.mock('$lib/server/brand/activation', () => ({ activateBrandModule: activateMock }))

const { POST } = await import('./+server')

describe('/api/brand/activate', () => {
  beforeEach(() => {
    activateMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('requires an admin', async () => {
    requireAdminMock.mockRejectedValueOnce(new Error('403'))
    await expect(POST({ locals: { user: null } } as never)).rejects.toThrow('403')
    expect(activateMock).not.toHaveBeenCalled()
  })

  it('delegates to activateBrandModule with the admin user', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    activateMock.mockResolvedValueOnce({ activated: true })
    const res = await POST({ locals: { user } } as never)
    expect(activateMock).toHaveBeenCalledWith(user)
    await expect(res.json()).resolves.toEqual({ activated: true })
  })

  it('surfaces the pending approval for the conversational yes', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    activateMock.mockResolvedValueOnce({ pendingApproval: true })
    const res = await POST({ locals: { user } } as never)
    await expect(res.json()).resolves.toEqual({ pendingApproval: true })
  })
})
