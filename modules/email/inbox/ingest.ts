import type { RawMailSource } from './raw-source'
import type { AttachmentRow, InboxStore, MailboxRow, MessageRow, MessageVerdicts } from './store'
import type { Folder } from './types'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { parseMime } from './mime'
import { RawMailTooLarge } from './raw-source'
import { VERDICTS } from './types'

/**
 * Inbound mail ingest (plan/email-inbox.md §3, S3): one SES receipt
 * notification (S3 action + topic) → the raw MIME from the inbound bucket →
 * one stored row per receiving mailbox. Routing uses structured fields only:
 * the envelope recipients (`receipt.recipients`, so Bcc arrives) looked up as
 * exact addresses, and SES's verdict statuses for the folder.
 */

/** SES receiving caps a mail at 40 MB including attachments and encoding. */
export const MAX_RAW_BYTES = 40 * 1024 * 1024

/** A notification that can never be stored (wrong action/bucket, malformed, too large): answered 4xx, not retried. */
export class IngestRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IngestRejected'
  }
}

const verdict = z.object({ status: z.enum(VERDICTS) }).passthrough()

const receivedSchema = z
  .object({
    notificationType: z.literal('Received'),
    mail: z
      .object({
        messageId: z.string().min(1),
        timestamp: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a timestamp'),
        source: z.string(),
      })
      .passthrough(),
    receipt: z
      .object({
        recipients: z.array(z.string().min(1)).min(1),
        spamVerdict: verdict,
        virusVerdict: verdict,
        spfVerdict: verdict,
        dkimVerdict: verdict,
        dmarcVerdict: verdict,
        dmarcPolicy: z.enum(['none', 'quarantine', 'reject']).optional(),
        action: z
          .object({ type: z.string(), bucketName: z.string().optional(), objectKey: z.string().optional() })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough()

export type ReceivedNotification = z.infer<typeof receivedSchema>

/**
 * The Message of an SNS Notification on the inbound topic. `other` is a
 * well-formed notification that carries no mail (e.g. SES's setup test).
 */
export function parseReceipt(
  message: unknown,
): { kind: 'received'; notification: ReceivedNotification } | { kind: 'other'; notificationType: string } {
  const head = z.object({ notificationType: z.string().min(1) }).passthrough().safeParse(message)
  if (!head.success) throw new IngestRejected('The notification is not an SES receipt notification.')
  if (head.data.notificationType !== 'Received') return { kind: 'other', notificationType: head.data.notificationType }
  const full = receivedSchema.safeParse(message)
  if (!full.success) throw new IngestRejected(`The SES receipt notification is malformed (${full.error.issues[0]?.path.join('.')}).`)
  return { kind: 'received', notification: full.data }
}

export function verdictsOf(n: ReceivedNotification): MessageVerdicts {
  const r = n.receipt
  return { spam: r.spamVerdict.status, virus: r.virusVerdict.status, spf: r.spfVerdict.status, dkim: r.dkimVerdict.status, dmarc: r.dmarcVerdict.status }
}

/** Spam or virus FAIL, or DMARC FAIL where the sender's policy says quarantine/reject → Spam; else Inbox. */
export function folderOf(n: ReceivedNotification): Folder {
  const v = verdictsOf(n)
  const dmarcSaysSpam = v.dmarc === 'FAIL' && (n.receipt.dmarcPolicy === 'quarantine' || n.receipt.dmarcPolicy === 'reject')
  return v.spam === 'FAIL' || v.virus === 'FAIL' || dmarcSaysSpam ? 'spam' : 'inbox'
}

export type IngestLog = (event: 'received', fields: Record<string, string | number>) => void

export type IngestDeps = {
  store: InboxStore
  raw: RawMailSource
  newId?: () => string
  /** Ids, counts and sizes only. Default: console.info. */
  log?: IngestLog
}

export type IngestResult = {
  /** Rows newly stored (one per mailbox). */
  stored: number
  /** Mailboxes that already had this SES message (an SNS retry). */
  duplicates: number
  /** Envelope recipients that reach no enabled mailbox (unknown address, or a disabled mailbox). */
  skipped: number
}

const defaultLog: IngestLog = (event, fields) => console.info(`[inbox] ${event}`, fields)

export async function ingestReceived(deps: IngestDeps, n: ReceivedNotification, bucket: string): Promise<IngestResult> {
  const action = n.receipt.action
  if (action.type !== 'S3') throw new IngestRejected(`The receipt action is ${action.type}, not S3.`)
  if (action.bucketName !== bucket) throw new IngestRejected('The receipt names a bucket that is not this company’s inbound bucket.')
  if (!action.objectKey) throw new IngestRejected('The receipt has no S3 object key.')
  const key = action.objectKey
  const newId = deps.newId ?? randomUUID
  const log = deps.log ?? defaultLog
  const sesMessageId = n.mail.messageId

  // Exact address lookup; one row per mailbox, however many of its addresses received the mail.
  const recipients = [...new Set(n.receipt.recipients.map((r) => r.trim().toLowerCase()))]
  const found = await deps.store.mailboxesFor(recipients)
  const targets = new Map<string, MailboxRow>()
  for (const { mailbox } of found) if (mailbox.disabledAt === null) targets.set(mailbox.id, mailbox)
  const reaching = new Set(found.filter((f) => f.mailbox.disabledAt === null).map((f) => f.address))
  const skipped = recipients.filter((r) => !reaching.has(r)).length
  if (targets.size === 0) {
    log('received', { sesMessageId, stored: 0, duplicates: 0, skipped, sizeBytes: 0 })
    return { stored: 0, duplicates: 0, skipped }
  }

  let raw: Uint8Array
  try {
    raw = await deps.raw.getRaw(bucket, key)
  } catch (err) {
    if (err instanceof RawMailTooLarge) throw new IngestRejected(err.message)
    throw err
  }
  if (raw.byteLength > MAX_RAW_BYTES) throw new IngestRejected(`The received mail object is ${raw.byteLength} bytes, over the SES receiving cap.`)
  const mail = await parseMime(raw)
  const from = mail.from ?? (n.mail.source.trim() ? { name: null, address: n.mail.source.trim() } : null)
  if (!from) throw new IngestRejected('The mail has neither a From header nor an envelope sender.')

  const folder = folderOf(n)
  const verdicts = verdictsOf(n)
  const blocked = verdicts.virus === 'FAIL'
  const receivedAt = new Date(n.mail.timestamp)
  const threadIds = [...new Set([...(mail.inReplyTo ? [mail.inReplyTo] : []), ...mail.references])]

  let stored = 0
  let duplicates = 0
  for (const mailbox of targets.values()) {
    const id = newId()
    const row: MessageRow & { sesMessageId: string } = {
      id,
      mailboxId: mailbox.id,
      folder,
      threadId: (await deps.store.threadOf(mailbox.id, threadIds)) ?? newId(),
      messageId: mail.messageId,
      sesMessageId,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
      from,
      to: mail.to,
      cc: mail.cc,
      bcc: [],
      subject: mail.subject,
      snippet: mail.snippet,
      textBody: mail.textBody,
      htmlBody: mail.htmlBody,
      receivedAt,
      readAt: null,
      starred: false,
      verdicts,
      rawS3Key: key,
      sizeBytes: raw.byteLength,
      createdAt: new Date(),
    }
    const attachments: AttachmentRow[] = mail.attachments.map((a) => ({ id: newId(), messageId: id, ...a, blocked, createdAt: row.createdAt }))
    const out = await deps.store.insertReceived(row, attachments)
    if (out.stored) stored += 1
    else duplicates += 1
  }
  log('received', { sesMessageId, stored, duplicates, skipped, sizeBytes: raw.byteLength })
  return { stored, duplicates, skipped }
}
