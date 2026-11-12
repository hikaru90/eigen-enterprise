import type { AddressRow, AttachmentRow, FolderCount, InboxStore, MailboxRow, MailPerson, MessageRow, MessageSummary } from './store'
import type { Folder } from './types'
import { and, asc, desc, eq, getTableColumns, ilike, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AppDatabase } from '$lib/server/db/context'
import { rowsFromDbExecute } from '$lib/server/db/execute-rows'
import { inboxAttachments, inboxMessages, mailboxAddresses, mailboxes } from '$lib/server/db/inbox.schema'
import { INBOX_NOTIFY_CHANNEL } from './store'
import { VERDICTS } from './types'

/** InboxStore over Postgres (company-level tables, migrations 0129 + 0131). */

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

/** A literal ILIKE pattern: the reader's \\, % and _ are characters, not wildcards. */
export function containsPattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

function toMessage(r: typeof inboxMessages.$inferSelect): MessageRow {
  return { ...toSummary(r), textBody: r.textBody, htmlBody: r.htmlBody }
}

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
    async insertReceived(row, attachments: AttachmentRow[]) {
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(inboxMessages)
          .values(row)
          .onConflictDoNothing({
            target: [inboxMessages.mailboxId, inboxMessages.sesMessageId],
            where: sql`${inboxMessages.sesMessageId} IS NOT NULL`,
          })
          .returning({ id: inboxMessages.id })
        if (inserted.length === 0) return { stored: false }
        if (attachments.length > 0) await tx.insert(inboxAttachments).values(attachments)
        // Inside the transaction: delivered on commit, never for a rolled-back row.
        await tx.execute(sql`select pg_notify(${INBOX_NOTIFY_CHANNEL}, ${row.mailboxId})`)
        return { stored: true }
      })
    },
    async listAttachments(messageId) {
      return db.select().from(inboxAttachments).where(eq(inboxAttachments.messageId, messageId)).orderBy(asc(inboxAttachments.partIndex))
    },
    async threadOf(mailboxId, messageIds) {
      if (messageIds.length === 0) return null
      const [r] = await db
        .select({ threadId: inboxMessages.threadId })
        .from(inboxMessages)
        .where(and(eq(inboxMessages.mailboxId, mailboxId), inArray(inboxMessages.messageId, messageIds)))
        .orderBy(asc(inboxMessages.receivedAt), asc(inboxMessages.id))
        .limit(1)
      return r?.threadId ?? null
    },
    async mailboxesFor(addresses) {
      if (addresses.length === 0) return []
      const rows = await db
        .select({ address: mailboxAddresses.address, mailbox: mailboxes })
        .from(mailboxAddresses)
        .innerJoin(mailboxes, eq(mailboxes.id, mailboxAddresses.mailboxId))
        .where(inArray(mailboxAddresses.address, addresses))
      const byAddress = new Map(rows.map((r) => [r.address, r.mailbox]))
      return addresses.flatMap((address) => {
        const mailbox = byAddress.get(address)
        return mailbox ? [{ address, mailbox }] : []
      })
    },
    async getMessage(id) {
      const [r] = await db.select().from(inboxMessages).where(eq(inboxMessages.id, id)).limit(1)
      return r ? toMessage(r) : null
    },
    async listMessages(mailboxId, folder, limit, search) {
      const pattern = search === undefined ? null : containsPattern(search)
      const matches = pattern
        ? or(
            ilike(inboxMessages.subject, pattern),
            ilike(sql<string>`coalesce(${inboxMessages.from}->>'name', '')`, pattern),
            ilike(sql<string>`${inboxMessages.from}->>'address'`, pattern),
            ilike(inboxMessages.snippet, pattern),
          )
        : undefined
      const rows = await db
        .select(summaryColumns)
        .from(inboxMessages)
        .where(and(eq(inboxMessages.mailboxId, mailboxId), eq(inboxMessages.folder, folder), matches))
        .orderBy(desc(inboxMessages.receivedAt), desc(inboxMessages.id))
        .limit(limit)
      return rows.map(toSummary)
    },
    async folderCounts(mailboxId) {
      const rows = await db
        .select({
          folder: inboxMessages.folder,
          total: sql<number>`count(*)::int`,
          unread: sql<number>`(count(*) filter (where ${inboxMessages.readAt} is null))::int`,
        })
        .from(inboxMessages)
        .where(eq(inboxMessages.mailboxId, mailboxId))
        .groupBy(inboxMessages.folder)
      return new Map<Folder, FolderCount>(rows.map((r) => [r.folder, { total: Number(r.total), unread: Number(r.unread) }]))
    },
    async threadMessages(mailboxId, threadId) {
      const rows = await db
        .select()
        .from(inboxMessages)
        .where(and(eq(inboxMessages.mailboxId, mailboxId), eq(inboxMessages.threadId, threadId)))
        .orderBy(asc(inboxMessages.receivedAt), asc(inboxMessages.id))
      return rows.map(toMessage)
    },
    async updateMessage(id, patch) {
      await db.transaction(async (tx) => {
        const out = await tx.update(inboxMessages).set(patch).where(eq(inboxMessages.id, id)).returning({ mailboxId: inboxMessages.mailboxId })
        if (out.length === 0) throw new Error(`inbox message ${id} not found`)
        await tx.execute(sql`select pg_notify(${INBOX_NOTIFY_CHANNEL}, ${out[0]!.mailboxId})`)
      })
    },
    async getAttachment(id) {
      const [r] = await db.select().from(inboxAttachments).where(eq(inboxAttachments.id, id)).limit(1)
      return r ?? null
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
