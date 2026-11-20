import type { OpcPackage } from '../ooxml/package'
import type { MediaSource } from './render'

/**
 * Pixel size of a PNG, GIF, JPEG or BMP from its header (needed to tile
 * picture fills at their natural size); null when the format does not say
 * it up front.
 */
export function imageSize(bytes: Uint8Array, contentType: string): { width: number; height: number } | null {
  const b = bytes
  const be16 = (i: number) => (b[i]! << 8) | b[i + 1]!
  const be32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8)
  const le32 = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)
  const type = contentType.toLowerCase()
  if (type === 'image/png' && b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) return { width: be32(16), height: be32(20) }
  if (type === 'image/gif' && b.length >= 10 && b[0] === 0x47) return { width: le16(6), height: le16(8) }
  if (type === 'image/bmp' && b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) return { width: Math.abs(le32(18)), height: Math.abs(le32(22)) }
  if ((type === 'image/jpeg' || type === 'image/jpg') && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]!
      const len = be16(i + 2)
      // Start-of-frame markers (ITU T.81 Table B.1), not DHT/JPG/DAC.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: be16(i + 7), height: be16(i + 5) }
      i += 2 + len
    }
  }
  return null
}

/**
 * Object URLs for a package's images, made on first use and released with
 * `dispose()` when the viewer goes away.
 */
export function createMediaSource(pkg: OpcPackage): { media: MediaSource; dispose: () => void } {
  const made = new Map<string, { url: string; width: number | null; height: number | null }>()
  return {
    media(part) {
      const hit = made.get(part)
      if (hit) return hit
      if (!pkg.has(part)) return null
      const type = pkg.contentType(part)
      const bytes = pkg.bytes(part)
      const size = imageSize(bytes, type)
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type }))
      const entry = { url, width: size?.width ?? null, height: size?.height ?? null }
      made.set(part, entry)
      return entry
    },
    dispose() {
      for (const { url } of made.values()) URL.revokeObjectURL(url)
      made.clear()
    },
  }
}
