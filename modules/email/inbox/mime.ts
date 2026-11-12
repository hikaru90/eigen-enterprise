import type { MailPerson } from './store'
import { simpleParser, type AddressObject, type EmailAddress } from 'mailparser'

/**
 * Raw MIME → the fields a received mail is stored with (mailparser does the
 * parsing; this only reshapes its output). Header syntax only — nothing here
 * decides what a mail means.
 */

export type ParsedAttachment = {
  /** Position in mailparser's attachment list of this raw mail (how the download finds it again). */
  partIndex: number
  filename: string | null
  contentType: string
  sizeBytes: number
  /** Content-ID without angle brackets (inline parts referenced as cid:). */
  contentId: string | null
  /** md5 of the decoded bytes (mailparser's checksum). */
  checksum: string
}

export type ParsedMail = {
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  from: MailPerson | null
  to: MailPerson[]
  cc: MailPerson[]
  subject: string
  textBody: string | null
  htmlBody: string | null
  snippet: string
  attachments: ParsedAttachment[]
}

export const SNIPPET_CHARS = 200

/** RFC 5322 msg-ids (`<id>`), brackets removed; a bare token when a sender left the brackets off. */
export function msgIds(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  const out: string[] = []
  for (const v of Array.isArray(value) ? value : [value]) {
    const bracketed = [...v.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!)
    out.push(...(bracketed.length > 0 ? bracketed : v.split(/\s+/).filter(Boolean)))
  }
  return [...new Set(out)]
}

function people(value: AddressObject | AddressObject[] | undefined): MailPerson[] {
  const flat = (list: EmailAddress[]): EmailAddress[] => list.flatMap((a) => (a.group ? flat(a.group) : [a]))
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value]
  return list
    .flatMap((o) => flat(o.value))
    .filter((a): a is EmailAddress & { address: string } => typeof a.address === 'string' && a.address !== '')
    .map((a) => ({ name: a.name.trim() === '' ? null : a.name.trim(), address: a.address }))
}

export function snippetOf(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS)
}

export async function parseMime(raw: Uint8Array): Promise<ParsedMail> {
  const mail = await simpleParser(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength))
  // mailparser derives `text` from the HTML when a mail has no text part.
  const text = typeof mail.text === 'string' && mail.text !== '' ? mail.text : null
  return {
    messageId: msgIds(mail.messageId)[0] ?? null,
    inReplyTo: msgIds(mail.inReplyTo)[0] ?? null,
    references: msgIds(mail.references),
    from: people(mail.from)[0] ?? null,
    to: people(mail.to),
    cc: people(mail.cc),
    subject: mail.subject ?? '',
    textBody: text,
    htmlBody: typeof mail.html === 'string' && mail.html !== '' ? mail.html : null,
    snippet: snippetOf(text),
    attachments: mail.attachments.map((a, partIndex) => ({
      partIndex,
      filename: a.filename ?? null,
      contentType: a.contentType,
      sizeBytes: a.size,
      contentId: a.cid ?? null,
      checksum: a.checksum,
    })),
  }
}
