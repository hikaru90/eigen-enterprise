import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPackage } from '../ooxml/package'
import { createMediaSource, imageSize } from './media'
import { buildPptx, PNG_1PX } from './test-utils/build-pptx'

describe('image sizes from headers', () => {
  it('reads PNG, GIF, BMP and JPEG sizes', () => {
    expect(imageSize(PNG_1PX, 'image/png')).toEqual({ width: 1, height: 1 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x01, 0x10, 0x00])
    expect(imageSize(gif, 'image/gif')).toEqual({ width: 288, height: 16 })
    const bmp = new Uint8Array(26)
    bmp.set([0x42, 0x4d])
    bmp.set([100, 0, 0, 0], 18)
    bmp.set([0x9c, 0xff, 0xff, 0xff], 22) // -100: stored top-down
    expect(imageSize(bmp, 'image/bmp')).toEqual({ width: 100, height: 100 })
    // SOI, APP0 (length 16), SOF0: length 17, precision 8, height 480, width 640
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0])
    expect(imageSize(jpeg, 'image/jpeg')).toEqual({ width: 640, height: 480 })
    expect(imageSize(new Uint8Array([1, 2, 3]), 'image/webp')).toBeNull()
  })
})

describe("object URLs for a package's images", () => {
  afterEach(() => vi.restoreAllMocks())

  const source = () =>
    createMediaSource(
      readPackage(
        buildPptx({
          slides: [{ shapes: '' }],
          parts: { '/ppt/media/image1.png': { bytes: PNG_1PX, type: 'image/png' } },
        }),
      ),
    )

  it('makes an URL once per part, with the header size; parts that are not there stay null', () => {
    const create = vi.spyOn(URL, 'createObjectURL')
    const s = source()
    try {
      const first = s.media('/ppt/media/image1.png')
      expect(first).toEqual({ url: expect.stringMatching(/^blob:/), width: 1, height: 1 })
      expect(s.media('/ppt/media/image1.png')).toBe(first)
      expect(s.media('/ppt/media/nope.png')).toBeNull()
      expect(create).toHaveBeenCalledTimes(1)
    } finally {
      s.dispose()
    }
  })

  it('forget drops one part (revoked, made anew); dispose releases the rest', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const s = source()
    const old = s.media('/ppt/media/image1.png')!.url
    s.forget('/ppt/media/nope.png') // never made: nothing to revoke
    s.forget('/ppt/media/image1.png')
    expect(revoke).toHaveBeenCalledWith(old)
    const fresh = s.media('/ppt/media/image1.png')!
    expect(fresh.url).not.toBe(old)
    s.dispose()
    expect(revoke).toHaveBeenCalledWith(fresh.url)
  })
})
