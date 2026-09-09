import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeMock, requireAdminMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  requireAdminMock: vi.fn(),
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: requireAdminMock }))
vi.mock('../../handler', () => ({ executeBrandExtractTool: executeMock }))

const { GET } = await import('./+server')

const SESSION_ID = '0b8f8d9e-6a1e-4b3e-9c2f-1a2b3c4d5e6f'

describe('GET /api/brand/extract/session/[id]', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('rejects non-uuid session ids with 400', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    await expect(
      GET({ locals: { user }, params: { id: 'nope' } } as never),
    ).rejects.toMatchObject({ status: 400 })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('delegates to brand.extract_session_get', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    await GET({ locals: { user }, params: { id: SESSION_ID } } as never)
    expect(executeMock).toHaveBeenCalledWith('brand.extract_session_get', { sessionId: SESSION_ID }, user)
  })
})
