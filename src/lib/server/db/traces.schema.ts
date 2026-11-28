import { boolean, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/** Traces phone-home, the box side (migration 0201, plan/traces-phone-home.md T2). */

/** The single row (id = 1): on by default (owner, 2026-11-25); `salt` makes export ids and never leaves the box. */
export const traceShareSettings = pgTable('trace_share_settings', {
  id: smallint('id').primaryKey().default(1),
  enabled: boolean('enabled').default(true).notNull(),
  salt: text('salt').notNull(),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  lastError: text('last_error'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

/** Where the exporter stands in each source table: (at, id) of the last row it read. */
export const traceExportCursor = pgTable('trace_export_cursor', {
  source: text('source').primaryKey(),
  lastAt: timestamp('last_at', { withTimezone: true }).notNull(),
  lastId: text('last_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

/** Every batch exactly as sent (or to be sent): "What was sent" opens `body`. */
export const traceBatch = pgTable(
  'trace_batch',
  {
    id: uuid('id').primaryKey(),
    state: text('state', { enum: ['pending', 'sent', 'failed', 'withdrawn'] }).notNull(),
    spanCount: integer('span_count').notNull(),
    body: jsonb('body').$type<unknown>().notNull(),
    /** Open values not sent because they could not be classified (field + value, local only). */
    withheld: jsonb('withheld').$type<Array<{ field: string; value: string }>>().default([]).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  },
  (t) => [index('trace_batch_created_idx').on(t.createdAt)],
)

/** Jev's verdict on an open value (T1b), one per distinct (field, value). */
export const traceValueVerdict = pgTable(
  'trace_value_verdict',
  {
    field: text('field').notNull(),
    value: text('value').notNull(),
    verdict: text('verdict', { enum: ['usage_meta', 'personal_or_content'] }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.field, t.value], name: 'trace_value_verdict_pk' })],
)
