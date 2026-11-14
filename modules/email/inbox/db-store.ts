import type { AddressRow, AttachmentRow, FolderCount, InboxStore, LabelRow, MailboxRow, MailPerson, MessageRow, MessageSummary } from './store'
import type { Folder, LabelColor } from './types'
import { and, asc, desc, eq, exists, getTableColumns, ilike, inArray, isNull, notInArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AppDatabase } from '$lib/server/db/context'
import { rowsFromDbExecute } from '$lib/server/db/execute-rows'
import { inboxAttachments, inboxLabels, inboxMessageLabels, inboxMessages, mailboxAddresses, mailboxes } from '$lib/server/db/inbox.schema'
import { HIDDEN_FROM_VIEWS, INBOX_NOTIFY_CHANNEL } from './store'
import { LABEL_COLORS, VERDICTS } from './types'

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

function toLabel(r: typeof inboxLabels.$inferSelect): LabelRow {
  if (!(LABEL_COLORS as readonly string[]).includes(r.color)) throw new Error(`inbox label ${r.id} has an unknown colour: ${r.color}`)
  return { ...r, color: r.color as LabelColor }
}

function toSummary(r: SummaryRecord): MessageSummary {
  return {
    ...r,
    from: parsed<MailPerson>(person, r.from, 'from', r.id),
    to: parsed<MailPerson[]>(people, r.to, 'to', r.id),
    cc: parsed<MailPerson[]>(people, r.cc, 'cc', r.id),
    bcc: parsed<MailPerson[]>(people, r.bcc, 'bcc', r.id),
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
    async listMessages(mailboxId, query, limit) {
      const pattern = query.search === undefined ? null : containsPattern(query.search)
      const matches = pattern
        ? or(
            ilike(inboxMessages.subject, pattern),
            ilike(sql<string>`coalesce(${inboxMessages.from}->>'name', '')`, pattern),
            ilike(sql<string>`${inboxMessages.from}->>'address'`, pattern),
            ilike(inboxMessages.snippet, pattern),
          )
        : undefined
      const withAttachments = exists(db.select({ one: sql`1` }).from(inboxAttachments).where(eq(inboxAttachments.messageId, inboxMessages.id)))
      const rows = await db
        .select({
          ...summaryColumns,
          hasAttachments: sql<boolean>`${withAttachments}`,
          labelIds: sql<string[]>`coalesce((select array_agg(${inboxMessageLabels.labelId}::text order by ${inboxMessageLabels.labelId}) from ${inboxMessageLabels} where ${inboxMessageLabels.messageId} = ${inboxMessages.id}), '{}')`,
        })
        .from(inboxMessages)
        .where(
          and(
            eq(inboxMessages.mailboxId, mailboxId),
            query.folder === null ? notInArray(inboxMessages.folder, [...HIDDEN_FROM_VIEWS]) : eq(inboxMessages.folder, query.folder),
            matches,
            query.starred ? eq(inboxMessages.starred, true) : undefined,
            query.labelId === undefined
              ? undefined
              : exists(
                  db
                    .select({ one: sql`1` })
                    .from(inboxMessageLabels)
                    .where(and(eq(inboxMessageLabels.messageId, inboxMessages.id), eq(inboxMessageLabels.labelId, query.labelId))),
                ),
            query.filter === 'unread' ? isNull(inboxMessages.readAt) : undefined,
            query.filter === 'attachments' ? withAttachments : undefined,
          ),
        )
        .orderBy(
          ...(query.sort === 'oldest'
            ? [asc(inboxMessages.receivedAt), asc(inboxMessages.id)]
            : [desc(inboxMessages.receivedAt), desc(inboxMessages.id)]),
        )
        .limit(limit)
      return rows.map(({ hasAttachments, labelIds, ...r }) => ({ ...toSummary(r), hasAttachments: Boolean(hasAttachments), labelIds }))
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
    async listLabels(mailboxId) {
      const rows = await db
        .select()
        .from(inboxLabels)
        .where(eq(inboxLabels.mailboxId, mailboxId))
        .orderBy(sql`lower(${inboxLabels.name})`)
      return rows.map(toLabel)
    },
    async getLabel(id) {
      const [r] = await db.select().from(inboxLabels).where(eq(inboxLabels.id, id)).limit(1)
      return r ? toLabel(r) : null
    },
    async insertLabel(row) {
      await db.insert(inboxLabels).values(row)
    },
    async deleteLabel(id) {
      await db.transaction(async (tx) => {
        const out = await tx.delete(inboxLabels).where(eq(inboxLabels.id, id)).returning({ mailboxId: inboxLabels.mailboxId })
        if (out.length > 0) await tx.execute(sql`select pg_notify(${INBOX_NOTIFY_CHANNEL}, ${out[0]!.mailboxId})`)
      })
    },
    async messageLabelIds(messageId) {
      const rows = await db
        .select({ labelId: inboxMessageLabels.labelId })
        .from(inboxMessageLabels)
        .where(eq(inboxMessageLabels.messageId, messageId))
        .orderBy(sql`${inboxMessageLabels.labelId}::text`)
      return rows.map((r) => r.labelId)
    },
    async setMessageLabel(messageId, labelId, on) {
      await db.transaction(async (tx) => {
        if (on) await tx.insert(inboxMessageLabels).values({ messageId, labelId }).onConflictDoNothing()
        else await tx.delete(inboxMessageLabels).where(and(eq(inboxMessageLabels.messageId, messageId), eq(inboxMessageLabels.labelId, labelId)))
        const [m] = await tx.select({ mailboxId: inboxMessages.mailboxId }).from(inboxMessages).where(eq(inboxMessages.id, messageId))
        if (!m) throw new Error(`inbox message ${messageId} not found`)
        await tx.execute(sql`select pg_notify(${INBOX_NOTIFY_CHANNEL}, ${m.mailboxId})`)
      })
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
