import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeMock, requireAdminMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  requireAdminMock: vi.fn(),
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: requireAdminMock }))
vi.mock('../handler', () => ({
  executeBrandExtractTool: executeMock,
  parseJsonBody: async (request: Request) => request.json(),
}))

const { POST } = await import('./+server')

describe('POST /api/brand/extract/judge', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('delegates the owner verdict to brand.extract_judge', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    const input = { sessionId: '0b8f8d9e-6a1e-4b3e-9c2f-1a2b3c4d5e6f', round: 2, chosen: 1, note: 'closest' }
    await POST({ locals: { user }, request: { json: async () => input } } as never)
    expect(executeMock).toHaveBeenCalledWith('brand.extract_judge', input, user)
  })

  it('is human-only: anonymous callers never reach the tool', async () => {
    requireAdminMock.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403, body: { message: 'forbidden' } }))
    await expect(
      POST({ locals: { user: null }, request: { json: async () => ({}) } } as never),
    ).rejects.toMatchObject({ status: 403 })
    expect(executeMock).not.toHaveBeenCalled()
  })
})
