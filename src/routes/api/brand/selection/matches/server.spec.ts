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

describe('POST /api/brand/selection/matches', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('delegates the centroid match to brand.selection_matches', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    const input = {
      pickedIds: [
        '5b9af91a-b098-52ed-8677-a950940475be',
        '914014a5-a604-54d5-9807-ad2bc7681f65',
        '6aa31cc5-4312-5527-8000-ce62084ebf36',
      ],
    }
    await POST({ locals: { user }, request: { json: async () => input } } as never)
    expect(executeMock).toHaveBeenCalledWith('brand.selection_matches', input, user)
  })

  it('is owner-only: anonymous callers never reach the tool', async () => {
    requireAdminMock.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { status: 403, body: { message: 'forbidden' } }),
    )
    await expect(
      POST({ locals: { user: null }, request: { json: async () => ({}) } } as never),
    ).rejects.toMatchObject({ status: 403 })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('rejects GET with 405', async () => {
    await expect(GET({ locals: { user: { id: 'owner-1' } } } as never)).rejects.toMatchObject({
      status: 405,
    })
  })
})
