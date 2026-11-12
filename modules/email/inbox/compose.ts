import type { MailPerson, MessageRow } from './store'
import { createHash } from 'node:crypto'
import addressparser from 'nodemailer/lib/addressparser'
import MailComposer from 'nodemailer/lib/mail-composer'
import { z } from 'zod'
import { InboxError } from './errors'

/**
 * Compose / reply / reply all / forward (plan/email-inbox.md §4, S5): the pure
 * half — recipient fields, limits, the prefilled subject and body, and the raw
 * MIME. Header syntax and fixed prefixes only; nothing here decides what a
 * mail means.
 */

export { COMPOSE_MODES, type ComposeMode } from './types'

/** To + Cc + Bcc together. */
export const MAX_RECIPIENTS = 50
export const MAX_SUBJECT_CHARS = 500
export const MAX_BODY_CHARS = 500_000
export const MAX_ATTACHMENTS = 20
/** Uploaded and forwarded attachments together (decoded bytes). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
/** Amazon SES refuses a mail over 40 MB once encoded. */
export const MAX_SEND_BYTES = 40 * 1024 * 1024

const email = z.email()

export type RecipientField = 'To' | 'Cc' | 'Bcc'

/** One recipient field as typed: `Name <a@b.c>, d@e.f; …`. Throws a plain InboxError on anything that isn't an address. */
export function parseRecipients(input: string, field: RecipientField): MailPerson[] {
  const text = input.trim()
  if (text === '') return []
  const parsed = addressparser(text, { flatten: true })
  const out: MailPerson[] = []
  for (const p of parsed) {
    const address = p.address.trim()
    if (!email.safeParse(address).success) {
      const shown = address || p.name.trim() || text
      throw new InboxError('invalid', `“${shown}” in ${field} isn’t an email address. Write addresses like name@example.com, separated by commas.`)
    }
    const name = p.name.trim()
    out.push({ name: name === '' ? null : name, address: address.toLowerCase() })
  }
  return out
}

/** One field of addresses as the form shows it again (`Name <a@b>, c@d`). */
export function formatRecipients(people: MailPerson[]): string {
  return people.map((p) => (p.name ? `${quoteName(p.name)} <${p.address}>` : p.address)).join(', ')
}

function quoteName(name: string): string {
  return /[",;<>@()[\]:\\]/.test(name) ? `"${name.replace(/[\\"]/g, (c) => `\\${c}`)}"` : name
}

/** Recipients of all three fields, each address once (first field wins), within the cap. */
export function dedupeRecipients(fields: { to: MailPerson[]; cc: MailPerson[]; bcc: MailPerson[] }): { to: MailPerson[]; cc: MailPerson[]; bcc: MailPerson[] } {
  const seen = new Set<string>()
  const keep = (list: MailPerson[]) =>
    list.filter((p) => {
      if (seen.has(p.address)) return false
      seen.add(p.address)
      return true
    })
  const out = { to: keep(fields.to), cc: keep(fields.cc), bcc: keep(fields.bcc) }
  const total = out.to.length + out.cc.length + out.bcc.length
  if (total === 0) throw new InboxError('invalid', 'Add at least one recipient in To, Cc or Bcc.')
  if (total > MAX_RECIPIENTS) throw new InboxError('invalid', `A mail can go to at most ${MAX_RECIPIENTS} addresses (To, Cc and Bcc together).`)
  return out
}

const RE = /^\s*re\s*:/i
const FWD = /^\s*(fwd?|fw)\s*:/i

/** `Re: <subject>` unless it already starts with Re:. */
export function replySubject(subject: string): string {
  const s = subject.trim()
  return RE.test(s) ? s : `Re: ${s}`.trim()
}

/** `Fwd: <subject>` unless it already starts with Fwd:/Fw:. */
export function forwardSubject(subject: string): string {
  const s = subject.trim()
  return FWD.test(s) ? s : `Fwd: ${s}`.trim()
}

const person = (p: MailPerson) => (p.name ? `${p.name} <${p.address}>` : p.address)

/** Fixed English date for quoted headers (the server's view; no reader locale on the server). */
function quotedDate(d: Date): string {
  return d.toUTCString()
}

/** The original's text below a reply: an attribution line and every line quoted with `> `. */
export function quotedReply(parent: Pick<MessageRow, 'from' | 'receivedAt' | 'textBody'>): string {
  const text = (parent.textBody ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  const quoted = text === '' ? '>' : text.split('\n').map((l) => (l === '' ? '>' : `> ${l}`)).join('\n')
  return `\n\nOn ${quotedDate(parent.receivedAt)}, ${person(parent.from)} wrote:\n${quoted}\n`
}

/** The forwarded header block and the original's text below a forward. */
export function forwardedBlock(parent: Pick<MessageRow, 'from' | 'to' | 'cc' | 'receivedAt' | 'subject' | 'textBody'>): string {
  const lines = [
    '---------- Forwarded message ---------',
    `From: ${person(parent.from)}`,
    `Date: ${quotedDate(parent.receivedAt)}`,
    `Subject: ${parent.subject}`,
    ...(parent.to.length > 0 ? [`To: ${parent.to.map(person).join(', ')}`] : []),
    ...(parent.cc.length > 0 ? [`Cc: ${parent.cc.map(person).join(', ')}`] : []),
  ]
  const text = (parent.textBody ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  return `\n\n${lines.join('\n')}\n\n${text}\n`
}

/**
 * Who a reply goes to. Reply: the original's sender — or, for a mail this
 * mailbox sent itself, its To. Reply all: also every To and Cc. Never one of
 * this mailbox's own addresses (`own`, lower-case), each address once.
 */
export function replyRecipients(
  parent: Pick<MessageRow, 'from' | 'to' | 'cc'>,
  own: Set<string>,
  mode: 'reply' | 'replyAll',
): { to: MailPerson[]; cc: MailPerson[] } {
  const norm = (p: MailPerson): MailPerson => ({ name: p.name, address: p.address.trim().toLowerCase() })
  const seen = new Set(own)
  const keep = (list: MailPerson[]) =>
    list.map(norm).filter((p) => {
      if (seen.has(p.address)) return false
      seen.add(p.address)
      return true
    })
  const fromUs = own.has(parent.from.address.trim().toLowerCase())
  const primary = fromUs ? parent.to : [parent.from]
  const to = keep(primary)
  if (mode === 'reply') return { to, cc: [] }
  const more = fromUs ? [] : parent.to
  return { to: [...to, ...keep(more)], cc: keep(parent.cc) }
}

/** C0 control characters and DEL. */
const isControl = (c: string) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f

/** An uploaded file's name: no path, no control characters, at most 200 characters; `attachment` when nothing is left. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = [...base].filter((c) => !isControl(c)).join('').replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
  if (clean === '') return 'attachment'
  if (clean.length <= 200) return clean
  const dot = clean.lastIndexOf('.')
  const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : ''
  return clean.slice(0, 200 - ext.length) + ext
}

/** A content type as given by the browser, when it is a plain `type/subtype`; otherwise octet-stream. */
export function cleanContentType(type: string): string {
  const t = type.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(t) ? t : 'application/octet-stream'
}

export type OutgoingAttachment = { filename: string; contentType: string; content: Buffer }

/** The attachment caps, on the decoded sizes of every attachment of one mail. */
export function checkAttachments(sizes: number[]): void {
  if (sizes.length > MAX_ATTACHMENTS) throw new InboxError('invalid', `A mail can carry at most ${MAX_ATTACHMENTS} attachments.`)
  const total = sizes.reduce((n, b) => n + b, 0)
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new InboxError('invalid', `The attachments come to ${mb(total)}. A mail can carry at most 25 MB of attachments — leave some out and send again.`)
  }
}

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

export const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex')

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The plain text as a minimal HTML alternative: escaped, line breaks kept, nothing else. */
export function textAsHtml(text: string): string {
  const body = escapeHtml(text.replace(/\r\n?/g, '\n')).split('\n').join('<br>\n')
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div style="font-family:sans-serif;white-space:pre-wrap">${body}</div></body></html>`
}

export type OutgoingMail = {
  from: MailPerson
  to: MailPerson[]
  cc: MailPerson[]
  subject: string
  text: string
  /** Without angle brackets. */
  messageId: string
  inReplyTo: string | null
  /** Header References, without angle brackets, in order. */
  references: string[]
  date: Date
  attachments: OutgoingAttachment[]
}

const addr = (p: MailPerson) => (p.name ? { name: p.name, address: p.address } : p.address)

/** The raw MIME (nodemailer's MailComposer). No Bcc header: Bcc lives in the SES envelope only. */
export async function buildMime(m: OutgoingMail): Promise<Buffer> {
  const composer = new MailComposer({
    from: addr(m.from),
    ...(m.to.length > 0 ? { to: m.to.map(addr) } : {}),
    ...(m.cc.length > 0 ? { cc: m.cc.map(addr) } : {}),
    subject: m.subject,
    text: m.text,
    html: textAsHtml(m.text),
    messageId: `<${m.messageId}>`,
    date: m.date,
    ...(m.inReplyTo ? { inReplyTo: `<${m.inReplyTo}>` } : {}),
    ...(m.references.length > 0 ? { references: m.references.map((r) => `<${r}>`) } : {}),
    attachments: m.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
  })
  return composer.compile().build()
}
