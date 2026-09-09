import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeMock, requireAdminMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  requireAdminMock: vi.fn(),
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: requireAdminMock }))
vi.mock('../handler', () => ({
  executeBrandTool: executeMock,
  parseJsonBody: async (request: Request) => request.json(),
}))

const { GET, POST } = await import('./+server')

describe('GET /api/brand/corpus', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('delegates the corpus read to brand.corpus_list', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    await GET({ locals: { user } } as never)
    expect(executeMock).toHaveBeenCalledWith('brand.corpus_list', {}, user)
  })

  it('is owner-only: anonymous callers never reach the tool', async () => {
    requireAdminMock.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { status: 403, body: { message: 'forbidden' } }),
    )
    await expect(GET({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 403 })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('rejects POST with 405', async () => {
    await expect(POST({ locals: { user: { id: 'owner-1' } } } as never)).rejects.toMatchObject({
      status: 405,
    })
  })
})
