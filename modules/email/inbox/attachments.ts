import type { RawMailSource } from './raw-source'
import type { InboxDeps } from './service'
import { simpleParser } from 'mailparser'
import { InboxError } from './errors'
import { attachmentFor } from './service'

/**
 * Attachment downloads (S4). The bytes were never copied into Postgres: they
 * are read again from the raw mail in the company's inbound bucket, the part
 * found by its position in mailparser's list and proven by its md5 (S3 notes).
 * Access goes through the message's mailbox, like every read.
 */

export type DownloadDeps = {
  inbox: InboxDeps
  raw: RawMailSource
  /** The company's inbound bucket (stored by the receiving setup). */
  bucket: () => Promise<string>
}

export const NOT_KEPT_MESSAGE = 'Attachments of mail sent from here aren’t kept, so they can’t be downloaded yet.'

export type AttachmentFile = { bytes: Uint8Array<ArrayBuffer>; filename: string | null; contentType: string; inline: boolean }

/** Raster images a browser shows without running anything (never SVG). */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export async function downloadAttachment(
  deps: DownloadDeps,
  userId: string,
  attachmentId: string,
  opts: { inline: boolean },
): Promise<AttachmentFile> {
  const { attachment, message } = await attachmentFor(deps.inbox, userId, attachmentId)
  if (attachment.blocked) {
    throw new InboxError('blocked', 'Blocked: Amazon found a virus in this mail. The attachment can’t be downloaded.')
  }
  if (!message.rawS3Key) {
    // Mail sent from here (no verdicts) keeps no raw copy (S5 notes): listed, not downloadable — in Sent or wherever it was moved.
    if (message.verdicts === null) throw new InboxError('not_kept', NOT_KEPT_MESSAGE)
    throw new Error(`inbox message ${message.id} has attachments but no raw mail`)
  }
  const raw = await deps.raw.getRaw(await deps.bucket(), message.rawS3Key)
  const mail = await simpleParser(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength))
  const part = mail.attachments[attachment.partIndex]
  if (!part) throw new Error(`the raw mail of ${message.id} has no part ${attachment.partIndex}`)
  if (part.checksum !== attachment.checksum) {
    throw new Error(`part ${attachment.partIndex} of the raw mail of ${message.id} does not match the stored attachment`)
  }
  const inline = opts.inline && attachment.contentId !== null && INLINE_TYPES.has(attachment.contentType.toLowerCase())
  return { bytes: new Uint8Array(part.content), filename: attachment.filename, contentType: attachment.contentType, inline }
}

/** RFC 5987 ext-value: encodeURIComponent leaves ' ( ) * as they are, which the header grammar does not allow. */
const rfc5987 = (v: string) => encodeURIComponent(v).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** Response headers: no sniffing, a sandbox CSP in case the browser renders it, the file name both ways. */
export function attachmentHeaders(file: AttachmentFile): Record<string, string> {
  const name = file.filename ?? 'attachment'
  // The ASCII fallback name keeps printable ASCII only.
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return {
    'content-type': file.contentType,
    'content-length': String(file.bytes.byteLength),
    'content-disposition': `${file.inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, no-store',
  }
}
