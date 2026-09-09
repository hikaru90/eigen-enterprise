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

const ITEM_ID = '5b9af91a-b098-52ed-8677-a950940475be'

describe('POST /api/brand/corpus/similar', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('delegates the body to brand.corpus_similar', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    const input = { itemId: ITEM_ID, limit: 5 }
    await POST({ locals: { user }, request: { json: async () => input } } as never)
    expect(executeMock).toHaveBeenCalledWith('brand.corpus_similar', input, user)
  })

  it('is owner-only: anonymous callers never reach the tool', async () => {
    requireAdminMock.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { status: 403, body: { message: 'forbidden' } }),
    )
    await expect(
      POST({ locals: { user: null }, request: { json: async () => ({ itemId: ITEM_ID }) } } as never),
    ).rejects.toMatchObject({ status: 403 })
    expect(executeMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/brand/corpus/similar', () => {
  beforeEach(() => {
    executeMock.mockReset()
    requireAdminMock.mockReset()
  })

  it('delegates itemId + limit from the query string to brand.corpus_similar', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    await GET({
      locals: { user },
      url: new URL(`https://ee.test/api/brand/corpus/similar?itemId=${ITEM_ID}&limit=3`),
    } as never)
    expect(executeMock).toHaveBeenCalledWith('brand.corpus_similar', { itemId: ITEM_ID, limit: 3 }, user)
  })

  it('omits the limit when the query string carries none', async () => {
    const user = { id: 'owner-1' }
    requireAdminMock.mockResolvedValueOnce(user)
    executeMock.mockResolvedValueOnce(new Response('{}'))
    await GET({
      locals: { user },
      url: new URL(`https://ee.test/api/brand/corpus/similar?itemId=${ITEM_ID}`),
    } as never)
    expect(executeMock).toHaveBeenCalledWith('brand.corpus_similar', { itemId: ITEM_ID }, user)
  })

  it('is owner-only: anonymous callers never reach the tool', async () => {
    requireAdminMock.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { status: 403, body: { message: 'forbidden' } }),
    )
    await expect(
      GET({
        locals: { user: null },
        url: new URL(`https://ee.test/api/brand/corpus/similar?itemId=${ITEM_ID}`),
      } as never),
    ).rejects.toMatchObject({ status: 403 })
    expect(executeMock).not.toHaveBeenCalled()
  })
})
