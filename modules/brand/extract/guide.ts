/**
 * Uploaded brand guides (contribute round 3, W7): what the extraction accepts
 * in place of a site capture. A PDF or an image goes to the model as is; the
 * type comes from the file's own format signature, never from its name.
 * Shared by the server (validation) and the upload form (accept list, limits),
 * so it imports nothing from node.
 */

export const GUIDE_MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const
export type GuideMime = (typeof GUIDE_MIMES)[number]

const MB = 1024 * 1024

/**
 * Images stay within 5 MB, the strictest per-image cap among the providers the
 * gateway reaches (Anthropic models); PDFs within 10 MB.
 */
export const GUIDE_MAX_BYTES = { pdf: 10 * MB, image: 5 * MB } as const

/** For the file picker's accept attribute. */
export const GUIDE_ACCEPT =
  'application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp'

/** One line for the upload form. */
export const GUIDE_LIMITS_TEXT = `A PDF up to ${GUIDE_MAX_BYTES.pdf / MB} MB, or an image (PNG, JPEG, WebP) up to ${GUIDE_MAX_BYTES.image / MB} MB.`

const MAX_FILENAME_LENGTH = 255

export type GuideUploadErrorCode = 'empty' | 'invalid' | 'too_large' | 'unsupported_type'

const STATUS: Record<GuideUploadErrorCode, number> = {
  empty: 400,
  invalid: 400,
  too_large: 413,
  unsupported_type: 415,
}

/** A refused upload: a plain sentence for the person, a code and an HTTP status for the route. */
export class GuideUploadError extends Error {
  readonly code: GuideUploadErrorCode
  readonly status: number

  constructor(code: GuideUploadErrorCode, message: string) {
    super(message)
    this.name = 'GuideUploadError'
    this.code = code
    this.status = STATUS[code]
  }
}

export type BrandGuideMeta = { filename: string; mime: GuideMime; sizeBytes: number }

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((byte, i) => bytes[offset + i] === byte)
}

/** The format signature (magic bytes) of the four accepted formats; null for anything else. */
export function detectGuideMime(bytes: Uint8Array): GuideMime | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf' // %PDF-
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  // RIFF....WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp'
  }
  return null
}

function megabytes(bytes: number): string {
  return (bytes / MB).toFixed(1)
}

/** Validates an uploaded guide: a name, a supported format, within its size limit. */
export function checkGuideUpload(input: { filename: string; bytes: Uint8Array }): BrandGuideMeta {
  const filename = input.filename.trim()
  if (filename.length === 0)
    throw new GuideUploadError('invalid', 'The brand guide needs a file name.')
  if (filename.length > MAX_FILENAME_LENGTH) {
    throw new GuideUploadError(
      'invalid',
      `The file name can be at most ${MAX_FILENAME_LENGTH} characters.`,
    )
  }
  if (input.bytes.length === 0) throw new GuideUploadError('empty', `“${filename}” is empty.`)
  const mime = detectGuideMime(input.bytes)
  if (mime === null) {
    throw new GuideUploadError(
      'unsupported_type',
      `“${filename}” isn't a PDF, PNG, JPEG or WebP file. Upload your brand guide in one of those formats.`,
    )
  }
  const isPdf = mime === 'application/pdf'
  const limit = isPdf ? GUIDE_MAX_BYTES.pdf : GUIDE_MAX_BYTES.image
  if (input.bytes.length > limit) {
    throw new GuideUploadError(
      'too_large',
      `“${filename}” is ${megabytes(input.bytes.length)} MB; ${isPdf ? 'PDFs' : 'images'} can be at most ${limit / MB} MB.`,
    )
  }
  return { filename, mime, sizeBytes: input.bytes.length }
}

const KIND_LABEL: Record<GuideMime, string> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/webp': 'WebP image',
}

/** The round-0 record of a guide session (where a URL session keeps its computed-style digest). */
export function guideDigest(guide: BrandGuideMeta): string {
  return `BRAND GUIDE: “${guide.filename}” (${KIND_LABEL[guide.mime]}, ${megabytes(guide.sizeBytes)} MB). The model reads the guide itself; there is no site capture.`
}
