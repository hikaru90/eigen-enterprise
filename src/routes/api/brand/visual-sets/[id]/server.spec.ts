import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeMock, requireAdminMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  requireAdminMock: vi.fn(),
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: requireAdminMock }))
vi.mock('../../handler', () => ({
  executeBrandTool: executeMock,
  parseJsonBody: async (request: Request) => request.json(),
}))

const { GET, POST } = await import('./+server')

const SET_ID = '7a000000-0000-4000-8000-00000000000a'

describe('GET /api/brand/visual-sets/[id]', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('rejects non-uuid set ids with 400', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    await expect(
      GET({ locals: { user }, params: { id: 'nope' } } as never),
    ).rejects.toMatchObject({ status: 400 })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('delegates the read to brand.visual_set_get', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    await GET({ locals: { user }, params: { id: SET_ID } } as never)
    expect(executeMock).toHaveBeenCalledWith('brand.visual_set_get', { setId: SET_ID }, user)
  })

  it('is owner-only: anonymous callers never reach the tool', async () => {
    requireAdminMock.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { status: 403, body: { message: 'forbidden' } }),
    )
    await expect(
      GET({ locals: { user: null }, params: { id: SET_ID } } as never),
    ).rejects.toMatchObject({ status: 403 })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('rejects POST with 405', async () => {
    await expect(
      POST({ locals: { user: { id: 'owner-1' } }, params: { id: SET_ID } } as never),
    ).rejects.toMatchObject({ status: 405 })
  })
})
