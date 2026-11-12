import type { MailboxSendInput } from '../owlery/service'
import type { RawMailSource } from './raw-source'
import type { InboxDeps, MailboxView } from './service'
import type { AttachmentRow, MailPerson, MessageRow } from './store'
import { simpleParser } from 'mailparser'
import {
  buildMime,
  checkAttachments,
  cleanContentType,
  dedupeRecipients,
  forwardedBlock,
  forwardSubject,
  formatRecipients,
  MAX_BODY_CHARS,
  MAX_SEND_BYTES,
  MAX_SUBJECT_CHARS,
  md5,
  parseRecipients,
  quotedReply,
  replyRecipients,
  replySubject,
  sanitizeFilename,
  type ComposeMode,
  type OutgoingAttachment,
} from './compose'
import { InboxError } from './errors'
import { snippetOf } from './mime'
import { getMessage, readableMailbox, readableMailboxes } from './service'

/**
 * Sending from a mailbox (plan/email-inbox.md §4, S5). Same access rule as
 * reading: you send from a mailbox only if you read it, and never from a
 * disabled one. The mail goes out through the owlery send path
 * (`sendMailboxMail`: sender check, suppression list, SES raw send — and no
 * company sent-log row, see S5 notes); the copy in Sent is stored after Amazon
 * accepted it, in the parent's thread for replies and forwards.
 */

export type MailboxTransport = { sendMailboxMail(input: MailboxSendInput): Promise<{ sesMessageId: string }> }

export type SendDeps = {
  inbox: InboxDeps
  transport: MailboxTransport
  /** Where forwarded attachments are read again from (the raw received mail). */
  raw: RawMailSource
  bucket: () => Promise<string>
}

export type Upload = { filename: string; contentType: string; bytes: Uint8Array }

export type SendInput = {
  mailboxId: string
  mode: ComposeMode
  /** The mail replied to or forwarded; null for new mail. */
  parentId: string | null
  /** The fields as typed. */
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  uploads: Upload[]
}

export type SentResult = { id: string; mailboxId: string; threadId: string }

const now = (deps: InboxDeps) => deps.now?.() ?? new Date()
const newId = (deps: InboxDeps) => deps.newId?.() ?? crypto.randomUUID()

type Sender = { box: MailboxView; from: MailPerson; own: Set<string> }

/** The display name recipients see: the mailbox's own, else (personal) the member's name. */
async function senderOf(deps: InboxDeps, box: MailboxView): Promise<Sender> {
  let name = box.displayName
  if (!name && box.kind === 'personal') {
    const member = (await deps.members()).find((m) => m.id === box.ownerUserId)
    name = member?.name.trim() || null
  }
  return { box, from: { name, address: box.address }, own: new Set([box.address, ...box.aliases]) }
}

const disabledMessage = (address: string) => `${address} is disabled, so no mail can be sent from it.`

async function sendableBox(deps: InboxDeps, userId: string, mailboxId: string): Promise<Sender> {
  const box = await readableMailbox(deps, userId, mailboxId)
  if (box.disabled) throw new InboxError('invalid', disabledMessage(box.address))
  return senderOf(deps, box)
}

async function parentOf(deps: InboxDeps, userId: string, mode: ComposeMode, parentId: string | null, mailboxId: string): Promise<MessageRow | null> {
  if (mode === 'new') return null
  if (!parentId) throw new InboxError('invalid', 'Pick the mail to reply to or forward first.')
  const parent = await getMessage(deps, userId, parentId)
  if (parent.mailboxId !== mailboxId) throw new InboxError('not_found', 'No such mail.')
  return parent
}

export type NotForwarded = { filename: string; reason: string }

/** Which of the original's attachments a forward carries, and which it can't (and why). */
function forwardPlan(parent: MessageRow, rows: AttachmentRow[]): { included: AttachmentRow[]; left: NotForwarded[] } {
  const included: AttachmentRow[] = []
  const left: NotForwarded[] = []
  for (const a of rows) {
    const filename = a.filename ?? 'attachment'
    if (a.blocked) left.push({ filename, reason: 'Amazon found a virus in this mail' })
    else if (parent.rawS3Key === null) left.push({ filename, reason: 'attachments of mail sent from here aren’t kept' })
    else included.push(a)
  }
  return { included, left }
}

/** The forwarded attachments' bytes, read again from the raw received mail and proven by checksum. */
async function forwardedAttachments(deps: SendDeps, parent: MessageRow, rows: AttachmentRow[]): Promise<OutgoingAttachment[]> {
  if (rows.length === 0) return []
  const raw = await deps.raw.getRaw(await deps.bucket(), parent.rawS3Key!)
  const mail = await simpleParser(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength))
  return rows.map((a) => {
    const part = mail.attachments[a.partIndex]
    if (!part) throw new Error(`the raw mail of ${parent.id} has no part ${a.partIndex}`)
    if (part.checksum !== a.checksum) throw new Error(`part ${a.partIndex} of the raw mail of ${parent.id} does not match the stored attachment`)
    return { filename: a.filename ?? 'attachment', contentType: a.contentType, content: Buffer.from(part.content) }
  })
}

function cleanSubject(subject: string): string {
  const s = subject.replace(/[\r\n]+/g, ' ').trim()
  if (s.length > MAX_SUBJECT_CHARS) throw new InboxError('invalid', `Keep the subject under ${MAX_SUBJECT_CHARS} characters.`)
  return s
}

export async function sendMail(deps: SendDeps, userId: string, input: SendInput): Promise<SentResult> {
  const sender = await sendableBox(deps.inbox, userId, input.mailboxId)
  const parent = await parentOf(deps.inbox, userId, input.mode, input.parentId, sender.box.id)
  const recipients = dedupeRecipients({
    to: parseRecipients(input.to, 'To'),
    cc: parseRecipients(input.cc, 'Cc'),
    bcc: parseRecipients(input.bcc, 'Bcc'),
  })
  const subject = cleanSubject(input.subject)
  const text = input.body.replace(/\r\n?/g, '\n')
  if (text.length > MAX_BODY_CHARS) throw new InboxError('invalid', 'The text is too long for one mail. Shorten it or send it as an attachment.')

  const uploads: OutgoingAttachment[] = input.uploads.map((u) => ({
    filename: sanitizeFilename(u.filename),
    contentType: cleanContentType(u.contentType),
    content: Buffer.from(u.bytes.buffer, u.bytes.byteOffset, u.bytes.byteLength),
  }))
  let forwarded: OutgoingAttachment[] = []
  if (parent && input.mode === 'forward') {
    const { included } = forwardPlan(parent, await deps.inbox.store.listAttachments(parent.id))
    // Checked before S3 is read: the stored sizes are the decoded sizes.
    checkAttachments([...uploads.map((u) => u.content.byteLength), ...included.map((a) => a.sizeBytes)])
    forwarded = await forwardedAttachments(deps, parent, included)
  }
  const attachments = [...forwarded, ...uploads]
  checkAttachments(attachments.map((a) => a.content.byteLength))

  const domain = sender.box.address.slice(sender.box.address.lastIndexOf('@') + 1)
  const ownMessageId = `${newId(deps.inbox)}@${domain}`
  const parentRefs = parent ? [...parent.references, ...(parent.messageId ? [parent.messageId] : [])] : []
  const references = [...new Set(parentRefs)]
  const inReplyTo = parent && input.mode !== 'forward' ? parent.messageId : null
  const date = now(deps.inbox)
  const raw = await buildMime({
    from: sender.from,
    to: recipients.to,
    cc: recipients.cc,
    subject,
    text,
    messageId: ownMessageId,
    inReplyTo,
    // Our own id closes the list: Amazon SES may replace the Message-ID header,
    // and a reply carries References on, so it still threads back (S5 notes).
    references: [...references, ownMessageId],
    date,
    attachments,
  })
  if (raw.byteLength > MAX_SEND_BYTES) {
    throw new InboxError('invalid', 'This mail is over 40 MB once encoded, more than Amazon SES sends. Leave out some attachments and send again.')
  }

  const { sesMessageId } = await deps.transport.sendMailboxMail({
    fromAddress: sender.box.address,
    recipients: {
      to: recipients.to.map((p) => p.address),
      cc: recipients.cc.map((p) => p.address),
      bcc: recipients.bcc.map((p) => p.address),
    },
    raw: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
  })

  const id = newId(deps.inbox)
  const threadId = parent?.threadId ?? newId(deps.inbox)
  const row: MessageRow & { sesMessageId: string } = {
    id,
    mailboxId: sender.box.id,
    folder: 'sent',
    threadId,
    messageId: ownMessageId,
    sesMessageId,
    inReplyTo,
    references,
    from: sender.from,
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    subject,
    snippet: snippetOf(text),
    textBody: text,
    htmlBody: null,
    receivedAt: date,
    readAt: date,
    starred: false,
    verdicts: null,
    rawS3Key: null,
    sizeBytes: raw.byteLength,
    createdAt: date,
  }
  // Metadata only: the sent copy keeps no raw mail, so its attachments are listed, not downloadable (S5 notes).
  const rows: AttachmentRow[] = attachments.map((a, partIndex) => ({
    id: newId(deps.inbox),
    messageId: id,
    partIndex,
    filename: a.filename,
    contentType: a.contentType,
    sizeBytes: a.content.byteLength,
    contentId: null,
    checksum: md5(a.content),
    blocked: false,
    createdAt: date,
  }))
  const out = await deps.inbox.store.insertReceived(row, rows)
  if (!out.stored) throw new Error(`the sent copy ${sesMessageId} is already stored in mailbox ${sender.box.id}`)
  return { id, mailboxId: sender.box.id, threadId }
}

// ─── the compose form's prefill ───────────────────────────────────────────────

export type ComposeDraft = {
  mode: ComposeMode
  parentId: string | null
  /** The mailbox it goes out from; null when there is none this person may send from. */
  fromMailboxId: string | null
  /** Mailboxes to pick From (new mail only; a reply goes out from the mailbox it is in). */
  fromChoices: Array<{ id: string; address: string; name: string | null }>
  to: string
  cc: string
  subject: string
  body: string
  /** Forward: the original's attachments it carries … */
  forwarded: Array<{ filename: string; sizeBytes: number }>
  /** … and those it can't. */
  notForwarded: NotForwarded[]
  /** Why nothing can be sent from here (a disabled mailbox); null when it can. */
  blocked: string | null
}

/**
 * What the compose form starts with. New mail: From = the mailbox you are in
 * (another you may send from when it is disabled). Reply / reply all /
 * forward: the opened mail's mailbox, recipients, subject and quoted text.
 */
export async function composeDraft(
  deps: InboxDeps,
  userId: string,
  input: { mailboxId: string; mode: ComposeMode; parentId: string | null },
): Promise<ComposeDraft> {
  const empty = { to: '', cc: '', subject: '', body: '', forwarded: [], notForwarded: [] }
  if (input.mode === 'new') {
    const here = await readableMailbox(deps, userId, input.mailboxId)
    const enabled = (await readableMailboxes(deps, userId)).filter((b) => !b.disabled)
    const choices = await Promise.all(enabled.map(async (b) => ({ id: b.id, address: b.address, name: (await senderOf(deps, b)).from.name })))
    const from = here.disabled ? (choices[0]?.id ?? null) : here.id
    return {
      mode: 'new',
      parentId: null,
      fromMailboxId: from,
      fromChoices: choices,
      ...empty,
      blocked: from === null ? disabledMessage(here.address) : null,
    }
  }
  const box = await readableMailbox(deps, userId, input.mailboxId)
  const parent = await parentOf(deps, userId, input.mode, input.parentId, box.id)
  if (!parent) throw new Error('a reply or forward needs its mail')
  const sender = await senderOf(deps, box)
  const base = {
    mode: input.mode,
    parentId: parent.id,
    fromMailboxId: box.id,
    fromChoices: [{ id: box.id, address: box.address, name: sender.from.name }],
    blocked: box.disabled ? disabledMessage(box.address) : null,
  }
  if (input.mode === 'forward') {
    const plan = forwardPlan(parent, await deps.store.listAttachments(parent.id))
    return {
      ...base,
      to: '',
      cc: '',
      subject: forwardSubject(parent.subject),
      body: forwardedBlock(parent),
      forwarded: plan.included.map((a) => ({ filename: a.filename ?? 'attachment', sizeBytes: a.sizeBytes })),
      notForwarded: plan.left,
    }
  }
  const r = replyRecipients(parent, sender.own, input.mode)
  return {
    ...base,
    to: formatRecipients(r.to),
    cc: formatRecipients(r.cc),
    subject: replySubject(parent.subject),
    body: quotedReply(parent),
    forwarded: [],
    notForwarded: [],
  }
}
