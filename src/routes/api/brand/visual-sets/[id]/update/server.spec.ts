import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeMock, requireAdminMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  requireAdminMock: vi.fn(),
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: requireAdminMock }))
vi.mock('../../../handler', () => ({
  executeBrandTool: executeMock,
  parseJsonBody: async (request: Request) => request.json(),
}))

const { GET, POST } = await import('./+server')

const SET_ID = '7a000000-0000-4000-8000-00000000000a'

function request(body: unknown): Request {
  return new Request('http://localhost/api/brand/visual-sets/x/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/brand/visual-sets/[id]/update', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('rejects non-uuid set ids with 400 before the tool runs', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    const event = { locals: { user }, params: { id: 'nope' }, request: request({}) }
    await expect(POST(event as never)).rejects.toMatchObject({ status: 400 })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('delegates the edit to brand.visual_set_update with the path setId', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    await POST({
      locals: { user },
      params: { id: SET_ID },
      request: request({ seedsPatch: { seedColor: { h: 42 } } }),
    } as never)
    expect(executeMock).toHaveBeenCalledWith(
      'brand.visual_set_update',
      { seedsPatch: { seedColor: { h: 42 } }, setId: SET_ID },
      user,
    )
  })

  it('the path setId wins over a spoofed body setId', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    await POST({
      locals: { user },
      params: { id: SET_ID },
      request: request({ setId: '8b000000-0000-4000-8000-00000000000b' }),
    } as never)
    expect(executeMock).toHaveBeenCalledWith(
      'brand.visual_set_update',
      { setId: SET_ID },
      user,
    )
  })

  it('is owner-only: anonymous callers never reach the tool', async () => {
    requireAdminMock.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { status: 403, body: { message: 'forbidden' } }),
    )
    await expect(
      POST({ locals: { user: null }, params: { id: SET_ID }, request: request({}) } as never),
    ).rejects.toMatchObject({ status: 403 })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it('rejects GET with 405', async () => {
    await expect(GET({ locals: { user: { id: 'owner-1' } } } as never)).rejects.toMatchObject({
      status: 405,
    })
  })
})
