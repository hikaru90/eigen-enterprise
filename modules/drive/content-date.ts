import sharp from 'sharp'

/**
 * When a file is from, as the file itself records it (Contribute `0c945439`):
 * the moment a photo was taken (EXIF DateTimeOriginal, else DateTimeDigitized)
 * or a PDF was created (its Info dictionary's /CreationDate, else the XMP
 * xmp:CreateDate). Only structured metadata fields are read — nothing is
 * guessed from the content. A file that records none gets null, and Drive
 * shows when it was uploaded instead.
 *
 * Every recorded date is kept as the wall clock it says, stored as that time
 * in UTC: EXIF dates carry no time zone, and a PDF's offset would only move a
 * date written just after midnight on the 1st into the previous month (Drive
 * shows the month and year the file says, so it reads them back in UTC).
 */

export type ContentDateKind = 'taken' | 'created'
export type ContentDate = { at: Date; kind: ContentDateKind }

const EXIF_IFD_POINTER = 0x8769
const DATE_TIME_ORIGINAL = 0x9003
const DATE_TIME_DIGITIZED = 0x9004
const ASCII = 2
const LONG = 4

/** A calendar date from its parts, or null when the parts are not a real date. */
function dateOf(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date | null {
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  // Date.UTC rolls 31 February over into March: that is not a date.
  const check = new Date(Date.UTC(y, mo - 1, d))
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  return at
}

const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/

/** EXIF's "YYYY:MM:DD HH:MM:SS" (zero and blank dates mean unknown). */
export function parseExifDate(raw: string): Date | null {
  const m = EXIF_DATE.exec(raw.trim())
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  return dateOf(y, mo, d, h, mi, s)
}

const num = (v: string | undefined, dflt: number) => (v === undefined ? dflt : Number(v))

// The time zone part is matched (so the date is well-formed) and not applied: see the module comment.
const PDF_DATE = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:Z|[+-]\d{2}'?(?:\d{2}'?)?)?$/

/** PDF's "D:YYYYMMDDHHmmSSOHH'mm'" — everything after the year optional (PDF 32000-1 §7.9.4). */
export function parsePdfDate(raw: string): Date | null {
  const m = PDF_DATE.exec(raw.trim())
  if (!m) return null
  return dateOf(Number(m[1]), num(m[2], 1), num(m[3], 1), num(m[4], 0), num(m[5], 0), num(m[6], 0))
}

const XMP_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?)?)?$/

/** XMP's ISO 8601 subset ("2011-09-30T14:05:00Z", or just "2011"). */
function parseXmpDate(raw: string): Date | null {
  const m = XMP_DATE.exec(raw.trim())
  if (!m) return null
  return dateOf(Number(m[1]), num(m[2], 1), num(m[3], 1), num(m[4], 0), num(m[5], 0), num(m[6], 0))
}

/** The entries of one TIFF IFD by tag. */
function readIfd(tiff: Buffer, offset: number, little: boolean): Map<number, { type: number; count: number; value: number }> {
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at))
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at))
  const tags = new Map<number, { type: number; count: number; value: number }>()
  if (offset + 2 > tiff.length) return tags
  const n = u16(offset)
  for (let i = 0; i < n; i++) {
    const at = offset + 2 + i * 12
    if (at + 12 > tiff.length) break
    // `value` is the entry's value field: the value itself when it fits in 4 bytes, else where it is.
    tags.set(u16(at), { type: u16(at + 2), count: u32(at + 4), value: at + 8 })
  }
  return tags
}

/** DateTimeOriginal, else DateTimeDigitized, from a raw EXIF block (TIFF, optionally after "Exif\0\0"). */
function exifTakenAt(exif: Buffer): Date | null {
  const tiff = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? exif.subarray(6) : exif
  if (tiff.length < 8) return null
  const order = tiff.subarray(0, 2).toString('latin1')
  if (order !== 'II' && order !== 'MM') return null
  const little = order === 'II'
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at))
  const ifd0 = readIfd(tiff, u32(4), little)
  const pointer = ifd0.get(EXIF_IFD_POINTER)
  if (!pointer || pointer.type !== LONG) return null
  const exifIfd = readIfd(tiff, u32(pointer.value), little)
  for (const tag of [DATE_TIME_ORIGINAL, DATE_TIME_DIGITIZED]) {
    const entry = exifIfd.get(tag)
    if (!entry || entry.type !== ASCII || entry.count === 0) continue
    const start = entry.count <= 4 ? entry.value : u32(entry.value)
    if (start + entry.count > tiff.length) continue
    const at = parseExifDate(tiff.subarray(start, start + entry.count).toString('latin1').replace(/\0+$/, ''))
    if (at) return at
  }
  return null
}

async function imageTakenAt(bytes: Uint8Array): Promise<Date | null> {
  let exif: Buffer | undefined
  try {
    exif = (await sharp(Buffer.from(bytes)).metadata()).exif
  } catch {
    // Not an image sharp can read: it records no date we can see.
    return null
  }
  return exif ? exifTakenAt(exif) : null
}

// PDF syntax: the Info dictionary's literal string, and XMP's attribute or element form.
const PDF_CREATION = /\/CreationDate\s*\(([^)]*)\)/g
const XMP_CREATE = /xmp:CreateDate(?:="([^"]*)"|>([^<]*)<)/g

function pdfCreatedAt(bytes: Uint8Array): Date | null {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  for (const m of text.matchAll(PDF_CREATION)) {
    const at = parsePdfDate(m[1]!)
    if (at) return at
  }
  for (const m of text.matchAll(XMP_CREATE)) {
    const at = parseXmpDate(m[1] ?? m[2] ?? '')
    if (at) return at
  }
  return null
}

/** The date the file records about itself, or null (see the module comment). */
export async function contentDateOf(bytes: Uint8Array, mime: string): Promise<ContentDate | null> {
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
    const at = await imageTakenAt(bytes)
    return at ? { at, kind: 'taken' } : null
  }
  if (mime === 'application/pdf') {
    const at = pdfCreatedAt(bytes)
    return at ? { at, kind: 'created' } : null
  }
  return null
}
