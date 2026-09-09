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

describe('/api/brand/visual-sets', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('GET delegates the list read to brand.visual_set_list', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('[]'))
    await GET({ locals: { user } } as never)
    expect(executeMock).toHaveBeenCalledWith('brand.visual_set_list', {}, user)
  })

  it('POST delegates the wizard landing to brand.visual_set_create', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    const input = {
      name: 'Kindred draft',
      sourceItemId: '5b9af91a-b098-52ed-8677-a950940475be',
      pickedIds: [
        '914014a5-a604-54d5-9807-ad2bc7681f65',
        '6aa31cc5-4312-5527-8000-ce62084ebf36',
        'ce0d861a-7724-57f9-b393-20d0ff877a4a',
      ],
      cssVars: { '--background': '#ffffff', '--primary': '#333333' },
    }
    await POST({ locals: { user }, request: { json: async () => input } } as never)
    expect(executeMock).toHaveBeenCalledWith('brand.visual_set_create', input, user)
  })

  it('is owner-only: anonymous callers never reach the tools', async () => {
    requireAdminMock.mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403, body: { message: 'forbidden' } }),
    )
    await expect(GET({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 403 })
    await expect(
      POST({ locals: { user: null }, request: { json: async () => ({}) } } as never),
    ).rejects.toMatchObject({ status: 403 })
    expect(executeMock).not.toHaveBeenCalled()
  })
})
