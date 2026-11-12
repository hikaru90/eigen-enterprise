import { sql } from 'drizzle-orm'
import { bigint, check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Drive metadata (migration 0109, plan/phase-workspace.md D1 + W-5). Bytes
 * live on disk as content-addressed blobs (sha256); these rows say what is
 * where, who made it, and every revision of a Markdown/CSV file. Archiving
 * (migration 0126) is a state on a folder or file: when and by whom, both
 * set or both null.
 */

export const driveFolder = pgTable(
  'drive_folder',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id'),
    name: text('name').notNull(),
    ownerId: text('owner_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    trashedAt: timestamp('trashed_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: text('archived_by'),
  },
  (t) => [
    index('drive_folder_parent_idx').on(t.parentId),
    index('drive_folder_archived_idx').on(t.archivedAt).where(sql`${t.archivedAt} is not null`),
    check('drive_folder_archived_pair_check', sql`(${t.archivedAt} is null) = (${t.archivedBy} is null)`),
  ],
)

export const driveFile = pgTable(
  'drive_file',
  {
    id: text('id').primaryKey(),
    folderId: text('folder_id'),
    name: text('name').notNull(),
    ownerId: text('owner_id').notNull(),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    trashedAt: timestamp('trashed_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: text('archived_by'),
  },
  (t) => [
    index('drive_file_folder_idx').on(t.folderId),
    index('drive_file_sha_idx').on(t.sha256),
    index('drive_file_archived_idx').on(t.archivedAt).where(sql`${t.archivedAt} is not null`),
    index('drive_file_live_updated_idx').on(t.updatedAt).where(sql`${t.trashedAt} is null and ${t.archivedAt} is null`),
    check('drive_file_archived_pair_check', sql`(${t.archivedAt} is null) = (${t.archivedBy} is null)`),
  ],
)

export const driveRevision = pgTable(
  'drive_revision',
  {
    id: text('id').primaryKey(),
    fileId: text('file_id').notNull(),
    sha256: text('sha256').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    authorId: text('author_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('drive_revision_file_idx').on(t.fileId, t.createdAt), index('drive_revision_sha_idx').on(t.sha256)],
)

/** One editor at a time per Markdown/CSV file (migration 0110, W-6): the holding session and its heartbeat. */
export const driveEditLock = pgTable('drive_edit_lock', {
  fileId: text('file_id').primaryKey(),
  userId: text('user_id').notNull(),
  sessionId: text('session_id').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
})
