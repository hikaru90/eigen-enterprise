import type { AttachmentRow, MessageRow } from '../../../../../../modules/email/inbox/store'
import type { RequestHandler } from './$types'
import { randomUUID } from 'node:crypto'
import { error, json } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { dev } from '$app/environment'
import { buildMime } from '../../../../../../modules/email/inbox/compose'
import { parseMime, snippetOf } from '../../../../../../modules/email/inbox/mime'
import { processFakeRawMailSource } from '../../../../../../modules/email/inbox/raw-source'
import { FOLDERS } from '../../../../../../modules/email/inbox/types'

/**
 * Dev/e2e only (S4): seeds received mail for a test user straight through the
 * inbox store — no SES, no SNS, no S3.
 *
 *   POST { email, messages: [{ subject, from: { name, address }, text?, html?, folder? }] }
 *     → gives the user a personal mailbox on `inbox-e2e.test` (once) and stores
 *       the mail as received (insertReceived, so open Inbox pages hear it live)
 *     → { mailboxId, address, messages: [{ id, subject, messageId }] }
 *
 * S5 (sending), all optional:
 *   connectMail: true  → under MAIL_TRANSPORT=fake, makes sure the company's
 *                        (fake) Amazon SES is connected and the receiving bucket
 *                        is stored, so the mailbox can send and forwards can
 *                        read raw mail
 *   disabled: boolean  → disables / re-enables the user's mailbox
 *   messages[].attachments: [{ filename, contentType, contentBase64 }] → the mail
 *                        is also written as raw MIME into the fake inbound
 *                        bucket, its attachments stored as ingest would
 */

const E2E_INBOX_DOMAIN = 'inbox-e2e.test'

const body = z
  .object({
    email: z.string().email(),
    messages: z
      .array(
        z
          .object({
            subject: z.string(),
            from: z.object({ name: z.string().nullable(), address: z.string().email() }).strict(),
            text: z.string().optional(),
            html: z.string().optional(),
            folder: z.enum(FOLDERS).optional(),
            attachments: z
              .array(z.object({ filename: z.string().min(1), contentType: z.string().min(1), contentBase64: z.string() }).strict())
              .max(5)
              .optional(),
          })
          .strict(),
      )
      .max(50),
    connectMail: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .strict()

/** The fake transport's company SES account and inbound bucket (MAIL_TRANSPORT=fake only). */
async function connectFakeMail(): Promise<string> {
  const { configuredMailTransport, owleryService } = await import('../../../../../../modules/email/owlery/service')
  if (configuredMailTransport() !== 'fake') error(409, 'connectMail needs the app to run with MAIL_TRANSPORT=fake')
  const { defaultFakeMailStore } = await import('../../../../../../modules/email/owlery/fake-store')
  const { defaultOwleryStore } = await import('../../../../../../modules/email/owlery/store')
  const owlery = owleryService()
  if (!(await owlery.isConfigured())) {
    const sender = `company@${E2E_INBOX_DOMAIN}`
    await defaultFakeMailStore().verifyIdentity(sender)
    await owlery.saveVerified({
      region: 'eu-central-1',
      accessKeyId: 'AKIAFAKE',
      secretAccessKey: 'fake-secret',
      emailFrom: sender,
      testRecipient: sender,
      updatedBy: 'e2e-harness',
    })
  }
  const store = defaultOwleryStore()
  let bucket = (await store.read())?.receivingBucket ?? null
  if (!bucket) {
    bucket = 'ee-inbound-e2e'
    await store.writeReceiving({ receivingBucket: bucket })
  }
  return bucket
}

export const POST: RequestHandler = async ({ request }) => {
  if (!dev) return json({ error: 'Inbox harness API only available in dev mode' }, { status: 403 })
  let input: z.infer<typeof body>
  try {
    input = body.parse(await request.json())
  } catch (err) {
    error(400, `Invalid inbox harness body: ${err instanceof Error ? err.message : String(err)}`)
  }

  const { authDb } = await import('$lib/server/db/auth-db')
  const { user } = await import('$lib/server/db/auth.schema')
  const [person] = await authDb.select({ id: user.id }).from(user).where(eq(user.email, input.email)).limit(1)
  if (!person) error(404, `No user ${input.email}`)

  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  const { dbInboxStore } = await import('../../../../../../modules/email/inbox/db-store')
  const store = dbInboxStore(createScopedDrizzle(appSql))
  const [domain] = await appSql<{ id: string }[]>`
    insert into mail_domains (name, region, dkim_selector, public_key, status, created_by)
    values (${E2E_INBOX_DOMAIN}, 'eu-central-1', 'ee', 'e2e', 'SUCCESS', 'e2e-harness')
    on conflict (name) do update set name = excluded.name
    returning id`
  if (!domain) throw new Error('mail_domains upsert returned no row')

  let mailbox = await store.personalMailboxOf(person.id)
  if (!mailbox) {
    const now = new Date()
    mailbox = { id: randomUUID(), kind: 'personal', ownerUserId: person.id, groupId: null, displayName: null, disabledAt: null, createdBy: 'e2e-harness', createdAt: now, updatedAt: now }
    await store.insertMailbox(mailbox, {
      address: `u-${person.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)}@${E2E_INBOX_DOMAIN}`,
      mailboxId: mailbox.id,
      domainId: domain.id,
      primary: true,
      createdBy: 'e2e-harness',
      createdAt: now,
    })
  }
  const address = (await store.listAddresses()).find((a) => a.mailboxId === mailbox.id && a.primary)!.address
  if (input.disabled !== undefined) {
    await store.updateMailbox(mailbox.id, { disabledAt: input.disabled ? new Date() : null, updatedAt: new Date() })
  }
  const bucket = input.connectMail ? await connectFakeMail() : null

  const stored: Array<{ id: string; subject: string; messageId: string }> = []
  const start = Date.now()
  for (const [i, m] of input.messages.entries()) {
    const at = new Date(start + i * 1000)
    const sesMessageId = `e2e-${randomUUID()}`
    const text = m.text ?? null
    let attachments: AttachmentRow[] = []
    const id = randomUUID()
    if (m.attachments && m.attachments.length > 0) {
      if (!bucket) error(400, 'attachments need connectMail: true (the fake inbound bucket)')
      const raw = await buildMime({
        from: m.from,
        to: [{ name: null, address }],
        cc: [],
        subject: m.subject,
        text: text ?? '',
        messageId: `${sesMessageId}@sender.e2e`,
        inReplyTo: null,
        references: [],
        date: at,
        attachments: m.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.contentBase64, 'base64') })),
      })
      processFakeRawMailSource().objects.set(`${bucket}/${sesMessageId}`, new Uint8Array(raw))
      attachments = (await parseMime(new Uint8Array(raw))).attachments.map((a) => ({ id: randomUUID(), messageId: id, ...a, blocked: false, createdAt: at }))
    }
    const row: MessageRow & { sesMessageId: string } = {
      id,
      mailboxId: mailbox.id,
      folder: m.folder ?? 'inbox',
      threadId: randomUUID(),
      messageId: `${sesMessageId}@sender.e2e`,
      sesMessageId,
      inReplyTo: null,
      references: [],
      from: m.from,
      to: [{ name: null, address }],
      cc: [],
      bcc: [],
      subject: m.subject,
      snippet: snippetOf(text),
      textBody: text,
      htmlBody: m.html ?? null,
      receivedAt: at,
      readAt: null,
      starred: false,
      verdicts: { spam: 'PASS', virus: 'PASS', spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
      rawS3Key: sesMessageId,
      sizeBytes: (text?.length ?? 0) + (m.html?.length ?? 0),
      createdAt: at,
    }
    await store.insertReceived(row, attachments)
    stored.push({ id: row.id, subject: row.subject, messageId: row.messageId! })
  }
  return json({ mailboxId: mailbox.id, address, messages: stored })
}
