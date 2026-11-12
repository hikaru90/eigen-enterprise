import type { AddressRow, InboxStore, MailboxRow, MailPerson, MessageRow, MessageSummary } from './store'
import { and, asc, desc, eq, getTableColumns, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AppDatabase } from '$lib/server/db/context'
import { rowsFromDbExecute } from '$lib/server/db/execute-rows'
import { inboxMessages, mailboxAddresses, mailboxes } from '$lib/server/db/inbox.schema'
import { VERDICTS } from './types'

/** InboxStore over Postgres (company-level tables, migration 0129). */

const person = z.object({ name: z.string().nullable(), address: z.string().min(1) }).strict()
const people = z.array(person)
const verdict = z.enum(VERDICTS)
const verdicts = z.object({ spam: verdict, virus: verdict, spf: verdict, dkim: verdict, dmarc: verdict }).strict().nullable()

/** Malformed jsonb fails loud: only the service and the ingest write these columns. */
function parsed<T>(schema: z.ZodType<T>, value: unknown, what: string, id: string): T {
  const r = schema.safeParse(value)
  if (!r.success) throw new Error(`inbox message ${id} has malformed ${what}: ${r.error.issues[0]?.message}`)
  return r.data
}

type SummaryRecord = Omit<typeof inboxMessages.$inferSelect, 'textBody' | 'htmlBody'>

function toSummary(r: SummaryRecord): MessageSummary {
  return {
    ...r,
    from: parsed<MailPerson>(person, r.from, 'from', r.id),
    to: parsed<MailPerson[]>(people, r.to, 'to', r.id),
    cc: parsed<MailPerson[]>(people, r.cc, 'cc', r.id),
    verdicts: parsed(verdicts, r.verdicts, 'verdicts', r.id),
  }
}

const toAddress = (r: typeof mailboxAddresses.$inferSelect): AddressRow => ({
  address: r.address,
  mailboxId: r.mailboxId,
  domainId: r.domainId,
  primary: r.isPrimary,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
})

const addressValues = (a: AddressRow) => ({
  address: a.address,
  mailboxId: a.mailboxId,
  domainId: a.domainId,
  isPrimary: a.primary,
  createdBy: a.createdBy,
  createdAt: a.createdAt,
})

const { textBody: _t, htmlBody: _h, ...summaryColumns } = getTableColumns(inboxMessages)

export function dbInboxStore(db: AppDatabase): InboxStore {
  return {
    async insertMailbox(mailbox: MailboxRow, primary: AddressRow) {
      await db.transaction(async (tx) => {
        await tx.insert(mailboxes).values(mailbox)
        await tx.insert(mailboxAddresses).values(addressValues(primary))
      })
    },
    async getMailbox(id) {
      const [r] = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1)
      return r ?? null
    },
    async listMailboxes() {
      return db.select().from(mailboxes).orderBy(asc(mailboxes.createdAt), asc(mailboxes.id))
    },
    async updateMailbox(id, patch) {
      const out = await db.update(mailboxes).set(patch).where(eq(mailboxes.id, id)).returning({ id: mailboxes.id })
      if (out.length === 0) throw new Error(`mailbox ${id} not found`)
    },
    async personalMailboxOf(userId) {
      const [r] = await db
        .select()
        .from(mailboxes)
        .where(and(eq(mailboxes.kind, 'personal'), eq(mailboxes.ownerUserId, userId)))
        .limit(1)
      return r ?? null
    },
    async getAddress(address) {
      const [r] = await db.select().from(mailboxAddresses).where(eq(mailboxAddresses.address, address)).limit(1)
      return r ? toAddress(r) : null
    },
    async listAddresses() {
      const rows = await db
        .select()
        .from(mailboxAddresses)
        .orderBy(asc(mailboxAddresses.mailboxId), desc(mailboxAddresses.isPrimary), asc(mailboxAddresses.address))
      return rows.map(toAddress)
    },
    async insertAddress(row) {
      await db.insert(mailboxAddresses).values(addressValues(row))
    },
    async deleteAlias(address) {
      await db.delete(mailboxAddresses).where(and(eq(mailboxAddresses.address, address), eq(mailboxAddresses.isPrimary, false)))
    },
    async insertMessage(row: MessageRow) {
      await db.insert(inboxMessages).values(row)
    },
    async getMessage(id) {
      const [r] = await db.select().from(inboxMessages).where(eq(inboxMessages.id, id)).limit(1)
      return r ? { ...toSummary(r), textBody: r.textBody, htmlBody: r.htmlBody } : null
    },
    async listMessages(mailboxId, folder, limit) {
      const rows = await db
        .select(summaryColumns)
        .from(inboxMessages)
        .where(and(eq(inboxMessages.mailboxId, mailboxId), eq(inboxMessages.folder, folder)))
        .orderBy(desc(inboxMessages.receivedAt), desc(inboxMessages.id))
        .limit(limit)
      return rows.map(toSummary)
    },
    async stats() {
      const result = await db.execute(sql`
        select ${inboxMessages.mailboxId} as mailbox_id,
               count(*)::int as messages,
               count(*) filter (where ${inboxMessages.readAt} is null)::int as unread,
               coalesce(sum(${inboxMessages.sizeBytes}), 0)::bigint as size_bytes
        from ${inboxMessages}
        group by ${inboxMessages.mailboxId}`)
      const rows = rowsFromDbExecute<{ mailbox_id: string; messages: number; unread: number; size_bytes: string | number }>(result)
      return new Map(rows.map((r) => [r.mailbox_id, { messages: r.messages, unread: r.unread, sizeBytes: Number(r.size_bytes) }]))
    },
  }
}
