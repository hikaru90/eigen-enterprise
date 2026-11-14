import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.schema'
import { mailDomains } from './email.schema'

/**
 * Mailboxes (migrations 0129 + 0131, plan/email-inbox.md S1/S3): receiving addresses and
 * the mail they hold. Company-level tables (no RLS); who reads what is decided
 * in modules/email/inbox/service.ts. Consumed only by modules/email/inbox/db-store.ts.
 */

export const mailboxes = pgTable(
  'mailboxes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: ['personal', 'shared'] }).notNull(),
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'set null' }),
    /** A members group id (shared mailboxes). Groups are files-first, so no FK. */
    groupId: text('group_id'),
    displayName: text('display_name'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('mailboxes_personal_owner_idx').on(t.ownerUserId).where(sql`${t.kind} = 'personal'`),
    index('mailboxes_group_idx').on(t.groupId).where(sql`${t.groupId} IS NOT NULL`),
  ],
)

export const mailboxAddresses = pgTable(
  'mailbox_addresses',
  {
    address: text('address').primaryKey(),
    mailboxId: uuid('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    domainId: uuid('domain_id')
      .notNull()
      .references(() => mailDomains.id, { onDelete: 'restrict' }),
    isPrimary: boolean('is_primary').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('mailbox_addresses_primary_idx').on(t.mailboxId).where(sql`${t.isPrimary}`),
    index('mailbox_addresses_mailbox_idx').on(t.mailboxId),
  ],
)

export const inboxMessages = pgTable(
  'inbox_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mailboxId: uuid('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    folder: text('folder', { enum: ['inbox', 'sent', 'spam', 'trash', 'archive'] }).notNull(),
    threadId: uuid('thread_id').notNull(),
    messageId: text('message_id'),
    sesMessageId: text('ses_message_id'),
    inReplyTo: text('in_reply_to'),
    references: text('references').array().notNull().default(sql`'{}'::text[]`),
    from: jsonb('from').notNull(),
    to: jsonb('to').notNull().default(sql`'[]'::jsonb`),
    cc: jsonb('cc').notNull().default(sql`'[]'::jsonb`),
    /** Only the sender's own copy in Sent has any (migration 0132). */
    bcc: jsonb('bcc').notNull().default(sql`'[]'::jsonb`),
    subject: text('subject').notNull(),
    snippet: text('snippet').notNull(),
    textBody: text('text_body'),
    htmlBody: text('html_body'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    starred: boolean('starred').notNull().default(false),
    verdicts: jsonb('verdicts'),
    rawS3Key: text('raw_s3_key'),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('inbox_messages_ses_idx').on(t.mailboxId, t.sesMessageId).where(sql`${t.sesMessageId} IS NOT NULL`),
    index('inbox_messages_folder_idx').on(t.mailboxId, t.folder, t.receivedAt.desc()),
    index('inbox_messages_thread_idx').on(t.mailboxId, t.threadId),
    index('inbox_messages_message_id_idx').on(t.mailboxId, t.messageId).where(sql`${t.messageId} IS NOT NULL`),
  ],
)

/**
 * Attachment metadata of received mail (migration 0131, S3). Bytes are re-read
 * from the raw MIME object on download: `partIndex` is the position in
 * mailparser's attachment list, `checksum` its md5. `blocked` = virus FAIL.
 */
export const inboxAttachments = pgTable(
  'inbox_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => inboxMessages.id, { onDelete: 'cascade' }),
    partIndex: integer('part_index').notNull(),
    filename: text('filename'),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    contentId: text('content_id'),
    checksum: text('checksum').notNull(),
    blocked: boolean('blocked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('inbox_attachments_part_idx').on(t.messageId, t.partIndex)],
)

/** A mailbox's labels (migration 0142): named, one colour from INBOX_LABEL_COLORS, any number per mail. */
export const inboxLabels = pgTable(
  'inbox_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mailboxId: uuid('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('inbox_labels_name_idx').on(t.mailboxId, sql`lower(${t.name})`)],
)

export const inboxMessageLabels = pgTable(
  'inbox_message_labels',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => inboxMessages.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => inboxLabels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.labelId] }), index('inbox_message_labels_label_idx').on(t.labelId)],
)
