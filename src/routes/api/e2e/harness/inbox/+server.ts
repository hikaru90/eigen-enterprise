import type { MessageRow } from '../../../../../../modules/email/inbox/store'
import type { RequestHandler } from './$types'
import { randomUUID } from 'node:crypto'
import { error, json } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { dev } from '$app/environment'
import { snippetOf } from '../../../../../../modules/email/inbox/mime'
import { FOLDERS } from '../../../../../../modules/email/inbox/types'

/**
 * Dev/e2e only (S4): seeds received mail for a test user straight through the
 * inbox store — no SES, no SNS, no S3.
 *
 *   POST { email, messages: [{ subject, from: { name, address }, text?, html?, folder? }] }
 *     → gives the user a personal mailbox on `inbox-e2e.test` (once) and stores
 *       the mail as received (insertReceived, so open Inbox pages hear it live)
 *     → { mailboxId, address, messages: [{ id, subject }] }
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
          })
          .strict(),
      )
      .max(50),
  })
  .strict()

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

  const stored: Array<{ id: string; subject: string }> = []
  const start = Date.now()
  for (const [i, m] of input.messages.entries()) {
    const at = new Date(start + i * 1000)
    const sesMessageId = `e2e-${randomUUID()}`
    const text = m.text ?? null
    const row: MessageRow & { sesMessageId: string } = {
      id: randomUUID(),
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
    await store.insertReceived(row, [])
    stored.push({ id: row.id, subject: row.subject })
  }
  return json({ mailboxId: mailbox.id, address, messages: stored })
}
