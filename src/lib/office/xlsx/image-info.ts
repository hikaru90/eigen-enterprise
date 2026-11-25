import { XlsxError } from './workbook'

/**
 * The picture formats a workbook can embed and Excel shows (PNG, JPEG, GIF,
 * BMP), told apart by their signature bytes, with their pixel size read from
 * the header (PNG IHDR, JPEG SOFn, GIF logical screen, BMP info header).
 */

export type ImageInfo = { ext: 'png' | 'jpeg' | 'gif' | 'bmp'; contentType: string; width: number; height: number }

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
const le32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0

export const IMAGE_CONTENT_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
} as const

/** The image's format and size; throws when it is none of the formats above. */
export function imageInfo(b: Uint8Array): ImageInfo {
  if (b.length > 24 && be32(b, 0) === 0x89504e47 && be32(b, 4) === 0x0d0a1a0a)
    return { ext: 'png', contentType: IMAGE_CONTENT_TYPES.png, width: be32(b, 16), height: be32(b, 20) }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return { ext: 'gif', contentType: IMAGE_CONTENT_TYPES.gif, width: le16(b, 6), height: le16(b, 8) }
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d)
    return {
      ext: 'bmp',
      contentType: IMAGE_CONTENT_TYPES.bmp,
      width: le32(b, 18),
      height: Math.abs(le32(b, 22) | 0),
    }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) break
      const marker = b[i + 1]!
      const len = be16(b, i + 2)
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { ext: 'jpeg', contentType: IMAGE_CONTENT_TYPES.jpeg, width: be16(b, i + 7), height: be16(b, i + 5) }
      i += 2 + len
    }
    throw new XlsxError('This JPEG picture has no readable size.')
  }
  throw new XlsxError('Only PNG, JPEG, GIF and BMP pictures can be put into a workbook.')
}
