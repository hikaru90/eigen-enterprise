import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import type { Author, LogBody } from '$lib/office/xlsx/collab/protocol'

/**
 * Server-authoritative co-editing state for Excel workbooks (migration 0186,
 * plan/phase-office-files.md §7.9): one session row per open/unsaved
 * workbook, its ordered operation log, and active peer presence across processes.
 */
export const sheetLiveSession = pgTable(
  'sheet_live_session',
  {
    fileId: text('file_id').primaryKey(),
    baseSha256: text('base_sha256').notNull(),
    baseSeq: integer('base_seq').notNull().default(0),
    headSeq: integer('head_seq').notNull().default(0),
    epochSeq: integer('epoch_seq').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    savedAt: timestamp('saved_at', { withTimezone: true }),
  },
  (t) => [
    index('sheet_live_session_unsaved_idx').on(t.updatedAt).where(sql`${t.headSeq} > ${t.baseSeq}`),
    check(
      'sheet_live_session_seq_check',
      sql`${t.baseSeq} >= 0 and ${t.headSeq} >= ${t.baseSeq} and ${t.epochSeq} >= 0 and ${t.epochSeq} <= ${t.baseSeq}`,
    ),
  ],
)

export const sheetLiveEntry = pgTable(
  'sheet_live_entry',
  {
    fileId: text('file_id').notNull(),
    seq: integer('seq').notNull(),
    clientId: text('client_id').notNull(),
    opId: text('op_id').notNull(),
    author: jsonb('author').$type<Author>().notNull(),
    body: jsonb('body').$type<LogBody>().notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'sheet_live_entry_pk', columns: [t.fileId, t.seq] }),
    uniqueIndex('sheet_live_entry_client_op_uq').on(t.fileId, t.clientId, t.opId),
    index('sheet_live_entry_file_at_idx').on(t.fileId, t.at),
    check('sheet_live_entry_seq_check', sql`${t.seq} >= 1`),
  ],
)

export const sheetLivePeer = pgTable(
  'sheet_live_peer',
  {
    fileId: text('file_id').notNull(),
    clientId: text('client_id').notNull(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    color: integer('color').notNull(),
    sheet: text('sheet'),
    range: text('range'),
    editing: boolean('editing').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'sheet_live_peer_pk', columns: [t.fileId, t.clientId] }),
    index('sheet_live_peer_updated_idx').on(t.fileId, t.updatedAt),
  ],
)
