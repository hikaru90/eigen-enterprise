import { describe, expect, it } from 'vitest'
import { checkAvatar, MAX_AVATAR_BYTES, resolveAvatarStorageDir, webpDimensions } from './avatar'

/** A WebP header with the given payload chunk (just enough bytes for the parser). */
function riff(chunk: string, payload: number[], total = 64): Uint8Array {
  const b = new Uint8Array(total)
  const put = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)))
  put(0, 'RIFF')
  new DataView(b.buffer).setUint32(4, total - 8, true)
  put(8, 'WEBP')
  put(12, chunk)
  new DataView(b.buffer).setUint32(16, total - 20, true)
  payload.forEach((v, i) => (b[20 + i] = v))
  return b
}

/** Lossless (VP8L): signature 0x2f, then (w-1) and (h-1) as 14-bit fields. */
function vp8l(w: number, h: number, total?: number): Uint8Array {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  return riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff], total)
}

/** Lossy (VP8): 3-byte frame tag, start code 9d 01 2a, 14-bit width/height. */
function vp8(w: number, h: number): Uint8Array {
  return riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, w & 0xff, (w >> 8) & 0x3f, h & 0xff, (h >> 8) & 0x3f])
}

/** Extended (VP8X): 4 flag bytes, then (w-1) and (h-1) as 24-bit little endian. */
function vp8x(w: number, h: number): Uint8Array {
  const a = w - 1
  const c = h - 1
  return riff('VP8X', [0x10, 0, 0, 0, a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff, c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff])
}

describe('webpDimensions', () => {
  it('reads lossy, lossless and extended WebP headers', () => {
    expect(webpDimensions(vp8(256, 256))).toEqual({ width: 256, height: 256 })
    expect(webpDimensions(vp8l(256, 128))).toEqual({ width: 256, height: 128 })
    expect(webpDimensions(vp8x(300, 300))).toEqual({ width: 300, height: 300 })
  })

  it('is null for anything that is not WebP', () => {
    const png = new Uint8Array(64)
    png.set([137, 80, 78, 71, 13, 10, 26, 10])
    expect(webpDimensions(png)).toBeNull()
    expect(webpDimensions(new Uint8Array(10))).toBeNull()
    expect(webpDimensions(riff('VP8 ', [0, 0, 0, 1, 2, 3]))).toBeNull() // bad start code
  })
})

describe('checkAvatar (the upload route’s limits)', () => {
  it('accepts a square WebP of 64–512 px', () => {
    expect(checkAvatar(vp8(256, 256), 'image/webp')).toEqual({ ok: true, width: 256, height: 256 })
    expect(checkAvatar(vp8l(64, 64), 'image/webp; charset=binary')).toMatchObject({ ok: true })
  })

  it('refuses another type with 415', () => {
    expect(checkAvatar(vp8(256, 256), 'image/png')).toMatchObject({ ok: false, status: 415 })
    expect(checkAvatar(vp8(256, 256), null)).toMatchObject({ ok: false, status: 415 })
  })

  it('refuses empty and oversized bodies', () => {
    expect(checkAvatar(new Uint8Array(0), 'image/webp')).toMatchObject({ ok: false, status: 400 })
    expect(checkAvatar(vp8l(256, 256, MAX_AVATAR_BYTES + 1), 'image/webp')).toMatchObject({ ok: false, status: 413 })
  })

  it('refuses bytes that only claim to be WebP, non-square and out-of-range sizes', () => {
    const fake = new Uint8Array(100).fill(7)
    expect(checkAvatar(fake, 'image/webp')).toMatchObject({ ok: false, status: 400, error: 'The picture is not a WebP image.' })
    expect(checkAvatar(vp8(256, 200), 'image/webp')).toMatchObject({ ok: false, error: expect.stringContaining('square') })
    expect(checkAvatar(vp8l(32, 32), 'image/webp')).toMatchObject({ ok: false, error: expect.stringContaining('between 64 and 512') })
    expect(checkAvatar(vp8x(1024, 1024), 'image/webp')).toMatchObject({ ok: false })
  })
})

describe('resolveAvatarStorageDir', () => {
  it('lives in its own namespace under the Drive storage dir', () => {
    expect(resolveAvatarStorageDir({ DRIVE_STORAGE_DIR: '/data/drive' })).toBe('/data/drive/profile')
    expect(resolveAvatarStorageDir({ EE_STATE_DIR: '/var/lib/ee' })).toBe('/var/lib/ee/drive/profile')
  })

  it('fails loud without storage (never a default location)', () => {
    expect(() => resolveAvatarStorageDir({})).toThrow(/Drive storage is not configured/)
  })
})
