import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock, putMock } = vi.hoisted(() => ({
  roleMock: vi.fn(async (): Promise<string | null> => 'admin'),
  putMock: vi.fn(async () => ({ sha256: 'a'.repeat(64), size: 64 })),
}))

vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))
vi.mock('$lib/server/profile/avatar', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/profile/avatar')>('$lib/server/profile/avatar')
  return {
    ...actual,
    avatarBlobs: () => ({ put: putMock, has: vi.fn(), get: vi.fn() }),
  }
})

import { POST } from './+server'

/** A 256 × 256 lossless WebP header. */
function webp(width = 256, height = 256): Uint8Array {
  const b = new Uint8Array(64)
  const put = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)))
  put(0, 'RIFF')
  put(8, 'WEBP')
  put(12, 'VP8L')
  const bits = (width - 1) | ((height - 1) << 14)
  b.set([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff], 20)
  return b
}

const call = (init: {
  user?: { id: string } | null
  body?: Uint8Array
  type?: string
  apiKey?: boolean
  contentLength?: number
}) =>
  POST({
    locals: {
      user: init.user === undefined ? { id: 'admin-1' } : init.user,
      apiKeyAuth: init.apiKey ? { id: 'k', name: 'k' } : undefined,
    },
    request: new Request('http://localhost/api/people/avatar/upload', {
      method: 'POST',
      headers: {
        ...(init.type ? { 'content-type': init.type } : {}),
        ...(init.contentLength === undefined ? {} : { 'content-length': String(init.contentLength) }),
      },
      body: (init.body ?? webp()) as BodyInit,
    }),
  } as never)

beforeEach(() => {
  roleMock.mockReset()
  roleMock.mockResolvedValue('admin')
  putMock.mockClear()
})

describe('POST /api/people/avatar/upload', () => {
  it('stores a valid square WebP in the avatar blob store and returns sha256 + image URL', async () => {
    const res = await call({ type: 'image/webp' })
    expect(res.status).toBe(200)
    expect(putMock).toHaveBeenCalledWith(expect.any(Uint8Array))
    const sha = 'a'.repeat(64)
    expect(await res.json()).toEqual({ sha256: sha, image: `/api/people/avatar/${sha}` })
  })

  it('requires a signed-in non-API-key user (401) and coworkers.manage capability (403)', async () => {
    expect((await call({ user: null, type: 'image/webp' })).status).toBe(401)
    expect((await call({ apiKey: true, type: 'image/webp' })).status).toBe(401)

    roleMock.mockResolvedValue('member')
    await expect(call({ type: 'image/webp' })).rejects.toMatchObject({ status: 403 })
    expect(putMock).not.toHaveBeenCalled()
  })

  it('refuses non-WebP content types, invalid bytes, and non-square images without storing', async () => {
    expect((await call({ type: 'image/png' })).status).toBe(415)

    const fake = await call({ type: 'image/webp', body: new Uint8Array(80).fill(1) })
    expect(fake.status).toBe(400)
    expect(await fake.json()).toMatchObject({
      error: 'The picture is not a WebP image.',
      agent: expect.objectContaining({
        attempted: 'Uploading an AI co-worker avatar (POST /api/people/avatar/upload)',
      }),
    })

    const rect = await call({ type: 'image/webp', body: webp(256, 128) })
    expect(rect.status).toBe(400)
    expect(putMock).not.toHaveBeenCalled()
  })

  it('refuses oversized payloads before reading the body', async () => {
    const res = await call({ type: 'image/webp', contentLength: 10 * 1024 * 1024 })
    expect(res.status).toBe(413)
    expect(putMock).not.toHaveBeenCalled()
  })
})
