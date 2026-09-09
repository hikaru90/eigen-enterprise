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

describe('POST /api/brand/extract/start', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('requires an owner/admin session (fail loud for anonymous)', async () => {
    requireAdminMock.mockRejectedValueOnce(Object.assign(new Error('login'), { status: 302, body: { message: 'login' } }))
    await expect(
      POST({ locals: { user: null }, request: { json: async () => ({}) } } as never),
    ).rejects.toMatchObject({ status: 302 })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('delegates to brand.extract_start with the admin user principal', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    await POST({
      locals: { user },
      request: { json: async () => ({ url: 'https://example.com' }) },
    } as never)
    expect(executeMock).toHaveBeenCalledWith('brand.extract_start', { url: 'https://example.com' }, user)
  })
})
