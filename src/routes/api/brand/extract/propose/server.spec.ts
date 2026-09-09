import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeMock, requireAdminMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  requireAdminMock: vi.fn(),
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: requireAdminMock }))
vi.mock('../handler', () => ({
  executeBrandExtractTool: executeMock,
  parseJsonBody: async (request: Request) => {
    try {
      return await request.json()
    } catch {
      throw Object.assign(new Error('Invalid JSON'), { status: 400, body: { message: 'Invalid JSON' } })
    }
  },
}))

const { POST } = await import('./+server')

describe('POST /api/brand/extract/propose', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('rejects invalid JSON with 400 before any tool call', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    await expect(
      POST({ locals: { user }, request: { json: async () => Promise.reject(new Error('bad')) } } as never),
    ).rejects.toMatchObject({ status: 400 })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('delegates to brand.extract_propose', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    await POST({
      locals: { user },
      request: { json: async () => ({ sessionId: '0b8f8d9e-6a1e-4b3e-9c2f-1a2b3c4d5e6f' }) },
    } as never)
    expect(executeMock).toHaveBeenCalledWith(
      'brand.extract_propose',
      { sessionId: '0b8f8d9e-6a1e-4b3e-9c2f-1a2b3c4d5e6f' },
      user,
    )
  })
})
