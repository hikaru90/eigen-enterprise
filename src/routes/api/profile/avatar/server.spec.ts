import { describe, expect, it, vi } from 'vitest'

const { saveAvatar, getProfile } = vi.hoisted(() => ({
  saveAvatar: vi.fn(async () => ({ image: '/api/people/avatar/x', sha256: 'x' })),
  getProfile: vi.fn(async () => ({ firstName: 'Ada', lastName: 'L', image: '/api/people/avatar/x', complete: true })),
}))
vi.mock('$lib/server/profile/service', () => ({ saveAvatar, getProfile }))

import { POST } from './+server'

/** A 256 × 256 lossless WebP header. */
function webp256(): Uint8Array {
  const b = new Uint8Array(64)
  const put = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)))
  put(0, 'RIFF')
  put(8, 'WEBP')
  put(12, 'VP8L')
  const bits = 255 | (255 << 14)
  b.set([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff], 20)
  return b
}

const call = (init: { user?: { id: string } | null; body?: Uint8Array; type?: string; apiKey?: boolean }) =>
  POST({
    locals: { user: init.user === undefined ? { id: 'u1' } : init.user, apiKeyAuth: init.apiKey ? { id: 'k', name: 'k' } : undefined },
    request: new Request('http://localhost/api/profile/avatar', {
      method: 'POST',
      headers: init.type ? { 'content-type': init.type } : {},
      body: (init.body ?? webp256()) as BodyInit,
    }),
  } as never)

describe('POST /api/profile/avatar', () => {
  it('stores a square WebP and returns the profile', async () => {
    const res = await call({ type: 'image/webp' })
    expect(res.status).toBe(200)
    expect(saveAvatar).toHaveBeenCalledWith('u1', expect.any(Uint8Array))
    expect(await res.json()).toMatchObject({ profile: { image: '/api/people/avatar/x' } })
  })

  it('is for signed-in people only (never an API key)', async () => {
    expect((await call({ user: null, type: 'image/webp' })).status).toBe(401)
    expect((await call({ apiKey: true, type: 'image/webp' })).status).toBe(401)
  })

  it('refuses other types and non-WebP bytes with the reason, storing nothing', async () => {
    saveAvatar.mockClear()
    const png = await call({ type: 'image/png' })
    expect(png.status).toBe(415)
    const fake = await call({ type: 'image/webp', body: new Uint8Array(80).fill(1) })
    expect(fake.status).toBe(400)
    expect(await fake.json()).toEqual({ error: 'The picture is not a WebP image.' })
    expect(saveAvatar).not.toHaveBeenCalled()
  })

  it('refuses a body over the size limit before reading it', async () => {
    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: new Request('http://localhost/api/profile/avatar', {
        method: 'POST',
        headers: { 'content-type': 'image/webp', 'content-length': String(10 * 1024 * 1024) },
        body: webp256() as BodyInit,
      }),
    } as never)
    expect(res.status).toBe(413)
  })
})
