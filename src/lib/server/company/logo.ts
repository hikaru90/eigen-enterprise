import type { UponSanitizeAttributeHook, UponSanitizeElementHook } from 'dompurify'
import { join } from 'node:path'
import DOMPurify, { type Config } from 'isomorphic-dompurify'
import sharp from 'sharp'
import { isLogoType, LOGO_TYPES, MAX_LOGO_BYTES, type LogoType } from '$lib/company/identity'
import { diskBlobStore, resolveDriveStorageDir, type BlobStore } from '../../../../modules/drive/storage'

/**
 * The company logo (Settings → Company): PNG, JPEG, WebP or SVG, at most
 * 1 MB. The server checks what it got — the declared type, the real file
 * header and that sharp can read it as that format — and stores the bytes
 * content-addressed with the Drive's blob helper in their own namespace
 * (<drive dir>/company), like profile pictures (<drive dir>/profile).
 *
 * SVG is markup, so it is never stored as uploaded: a file with scripts or
 * event handlers is refused (say so, instead of quietly breaking it), the
 * rest is sanitized (DOMPurify's SVG profile — editor metadata and links that
 * would run code are dropped) and must still render. The logo route also
 * serves it with a sandboxing CSP, and the app only shows it in <img>.
 */

export const MIN_LOGO_PX = 16
export const MAX_LOGO_PX = 4096

const LABEL: Record<LogoType, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/svg+xml': 'SVG',
  'image/webp': 'WebP',
}

type RasterType = Exclude<LogoType, 'image/svg+xml'>
const SHARP_FORMAT: Record<RasterType, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }

export type LogoCheck =
  | { ok: true; mime: LogoType; bytes: Uint8Array; width: number; height: number }
  | { ok: false; status: 400 | 413 | 415; error: string }

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len))
const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v)

/** The file header says it is this raster type. */
function headerIs(type: RasterType, b: Uint8Array): boolean {
  if (type === 'image/png') return startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (type === 'image/jpeg') return startsWith(b, [0xff, 0xd8, 0xff])
  return b.byteLength >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP'
}

const notA = (type: LogoType): LogoCheck => ({
  ok: false,
  status: 400,
  error: type === 'image/svg+xml' ? 'The file is not an SVG image.' : `The file is not a ${LABEL[type]} image.`,
})

async function readable(bytes: Uint8Array): Promise<{ format?: string; width?: number; height?: number } | null> {
  try {
    return await sharp(Buffer.from(bytes)).metadata()
  } catch {
    return null
  }
}

async function checkRaster(type: RasterType, bytes: Uint8Array): Promise<LogoCheck> {
  if (!headerIs(type, bytes)) return notA(type)
  const meta = await readable(bytes)
  if (!meta || meta.format !== SHARP_FORMAT[type] || !meta.width || !meta.height) return notA(type)
  const { width, height } = meta
  if (Math.min(width, height) < MIN_LOGO_PX) {
    return { ok: false, status: 400, error: `The logo is too small to show (${width}×${height}; at least ${MIN_LOGO_PX} pixels on each side).` }
  }
  if (Math.max(width, height) > MAX_LOGO_PX) {
    return { ok: false, status: 400, error: `The logo is too large (${width}×${height}; at most ${MAX_LOGO_PX} pixels on each side).` }
  }
  return { ok: true, mime: type, bytes, width, height }
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const SVG_PURIFY: Config = { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['use'] }

async function checkSvg(bytes: Uint8Array): Promise<LogoCheck> {
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return notA('image/svg+xml')
  }
  // Scoped hooks (the repo's DOMPurify pattern): only for this call.
  let scripted = false
  const onElement: UponSanitizeElementHook = (_node, data) => {
    if (data.tagName === 'script') scripted = true
  }
  const onAttribute: UponSanitizeAttributeHook = (_node, data) => {
    if (data.attrName.startsWith('on')) scripted = true
  }
  // A standalone SVG file needs its namespace to render as an image.
  const namespaced = (node: Element) => {
    if (node.nodeName.toLowerCase() === 'svg' && !node.parentElement?.closest('svg') && !node.hasAttribute('xmlns')) {
      node.setAttribute('xmlns', SVG_NS)
    }
  }
  DOMPurify.addHook('uponSanitizeElement', onElement)
  DOMPurify.addHook('uponSanitizeAttribute', onAttribute)
  DOMPurify.addHook('afterSanitizeAttributes', namespaced)
  let clean: string
  try {
    clean = String(DOMPurify.sanitize(source, SVG_PURIFY)).trim()
  } finally {
    DOMPurify.removeHook('uponSanitizeElement', onElement)
    DOMPurify.removeHook('uponSanitizeAttribute', onAttribute)
    DOMPurify.removeHook('afterSanitizeAttributes', namespaced)
  }
  if (scripted) {
    return { ok: false, status: 400, error: 'This SVG contains scripts. Export it as a plain SVG (or a PNG) and upload that.' }
  }
  if (!clean.startsWith('<svg')) return notA('image/svg+xml')
  const out = new TextEncoder().encode(clean)
  const meta = await readable(out)
  if (!meta || meta.format !== 'svg' || !meta.width || !meta.height) return notA('image/svg+xml')
  return { ok: true, mime: 'image/svg+xml', bytes: out, width: meta.width, height: meta.height }
}

/** What Settings → Company accepts as a logo; every refusal says why. */
export async function checkLogo(bytes: Uint8Array, declaredType: string | null): Promise<LogoCheck> {
  const type = (declaredType ?? '').split(';')[0].trim().toLowerCase()
  if (!isLogoType(type)) {
    const names = LOGO_TYPES.map((t) => LABEL[t])
    return {
      ok: false,
      status: 415,
      error: `A logo must be a ${names.slice(0, -1).join(', ')} or ${names.at(-1)} image (got ${type || 'no type'}).`,
    }
  }
  if (bytes.byteLength === 0) return { ok: false, status: 400, error: 'The file is empty.' }
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `The logo is too large (${Math.ceil(bytes.byteLength / 1024)} KB; at most ${MAX_LOGO_BYTES / 1024} KB).`,
    }
  }
  return type === 'image/svg+xml' ? checkSvg(bytes) : checkRaster(type, bytes)
}

/** <drive storage dir>/company — fails loud like the Drive when no storage is configured. */
export function resolveCompanyLogoDir(env: Record<string, string | undefined>): string {
  return join(resolveDriveStorageDir(env), 'company')
}

let live: BlobStore | null = null

export function companyLogoBlobs(env: Record<string, string | undefined> = process.env): BlobStore {
  live ??= diskBlobStore(resolveCompanyLogoDir(env))
  return live
}
