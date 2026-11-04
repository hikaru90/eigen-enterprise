import { join } from 'node:path'
import { diskBlobStore, resolveDriveStorageDir, type BlobStore } from '../../../../modules/drive/storage'

/**
 * Profile pictures (P-5): the browser crops and resizes to a square 256 px
 * WebP; the server checks what it got (type, size, real WebP header, square
 * dimensions) and stores the bytes content-addressed with the Drive's blob
 * helper — in their own namespace (<drive dir>/profile), so the Drive's
 * unused-blob cleanup never removes a picture and Drive behaviour is unchanged.
 */

export const AVATAR_MIME = 'image/webp'
/** A 256 px WebP is ~5–40 KB; anything this big was not made by the editor. */
export const MAX_AVATAR_BYTES = 256 * 1024
export const MIN_AVATAR_PX = 64
export const MAX_AVATAR_PX = 512

export type AvatarCheck = { ok: true; width: number; height: number } | { ok: false; status: 400 | 413 | 415; error: string }

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len))
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)

/**
 * Width and height from a WebP header (RIFF container; VP8 lossy, VP8L
 * lossless or VP8X extended), or null when the bytes are not a WebP image.
 */
export function webpDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.byteLength < 30) return null
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null
  const chunk = ascii(b, 12, 4)
  const data = 20
  if (chunk === 'VP8 ') {
    // Frame tag (3 bytes), start code 9d 01 2a, then 14-bit width and height.
    if (b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return null
    const width = (b[data + 6] | (b[data + 7] << 8)) & 0x3fff
    const height = (b[data + 8] | (b[data + 9] << 8)) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (chunk === 'VP8L') {
    if (b[data] !== 0x2f) return null
    const bits = b[data + 1] | (b[data + 2] << 8) | (b[data + 3] << 16) | (b[data + 4] << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    return { width: u24le(b, data + 4) + 1, height: u24le(b, data + 7) + 1 }
  }
  return null
}

/** What the upload route accepts; every refusal says why. */
export function checkAvatar(bytes: Uint8Array, contentType: string | null): AvatarCheck {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (type !== AVATAR_MIME) {
    return { ok: false, status: 415, error: `A profile picture must be sent as ${AVATAR_MIME} (got ${type || 'no type'}).` }
  }
  if (bytes.byteLength === 0) return { ok: false, status: 400, error: 'The picture is empty.' }
  if (bytes.byteLength > MAX_AVATAR_BYTES) {
    return { ok: false, status: 413, error: `The picture is too large (${Math.ceil(bytes.byteLength / 1024)} KB; at most ${MAX_AVATAR_BYTES / 1024} KB).` }
  }
  const dims = webpDimensions(bytes)
  if (!dims) return { ok: false, status: 400, error: 'The picture is not a WebP image.' }
  if (dims.width !== dims.height) {
    return { ok: false, status: 400, error: `The picture must be square (got ${dims.width}×${dims.height}).` }
  }
  if (dims.width < MIN_AVATAR_PX || dims.width > MAX_AVATAR_PX) {
    return { ok: false, status: 400, error: `The picture must be between ${MIN_AVATAR_PX} and ${MAX_AVATAR_PX} pixels wide (got ${dims.width}).` }
  }
  return { ok: true, ...dims }
}

/** <drive storage dir>/profile — fails loud like the Drive when no storage is configured. */
export function resolveAvatarStorageDir(env: Record<string, string | undefined>): string {
  return join(resolveDriveStorageDir(env), 'profile')
}

let live: BlobStore | null = null

export function avatarBlobs(env: Record<string, string | undefined> = process.env): BlobStore {
  live ??= diskBlobStore(resolveAvatarStorageDir(env))
  return live
}
