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

describe('POST /api/brand/extract/accept', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('delegates to brand.extract_accept', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    const input = { sessionId: '0b8f8d9e-6a1e-4b3e-9c2f-1a2b3c4d5e6f', name: 'Kindred web' }
    await POST({ locals: { user }, request: { json: async () => input } } as never)
    expect(executeMock).toHaveBeenCalledWith('brand.extract_accept', input, user)
  })
})
