import { describe, expect, it } from 'vitest'
import { imageSize } from './media'
import { PNG_1PX } from './test-utils/build-pptx'

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
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0])
    expect(imageSize(jpeg, 'image/jpeg')).toEqual({ width: 640, height: 480 })
    expect(imageSize(new Uint8Array([1, 2, 3]), 'image/webp')).toBeNull()
  })
})
