import { bigint, boolean, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'

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
  /** The owner saw the one-time Needs you notice (migration 0204); null until then, so new and upgraded installs get it. */
  noticeSeenAt: timestamp('notice_seen_at', { withTimezone: true }),
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

/** The makers' hub (migration 0202, T3): used only where the trace-hub module is active. */
export const hubTraceBatches = pgTable(
  'hub_trace_batches',
  {
    installId: uuid('install_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    spanCount: integer('span_count').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.installId, t.batchId], name: 'hub_trace_batches_pk' })],
)

export const hubTraceSpans = pgTable(
  'hub_trace_spans',
  {
    installId: uuid('install_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    traceId: uuid('trace_id').notNull(),
    spanId: uuid('span_id').notNull(),
    parentId: uuid('parent_id'),
    kind: text('kind').notNull(),
    runKind: text('run_kind'),
    tool: text('tool'),
    logContext: text('log_context'),
    model: text('model'),
    providerKind: text('provider_kind'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: doublePrecision('cost_usd'),
    durationMs: integer('duration_ms'),
    attempt: integer('attempt'),
    startOffsetMs: integer('start_offset_ms').notNull(),
    outcome: text('outcome').notNull(),
    errorCode: text('error_code'),
    auditClass: text('audit_class'),
    via: text('via'),
    appVersion: text('app_version').notNull(),
    eeVersion: text('ee_version'),
    day: date('day').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.installId, t.spanId], name: 'hub_trace_spans_pk' }),
    index('hub_trace_spans_day_idx').on(t.day),
    index('hub_trace_spans_trace_idx').on(t.installId, t.traceId),
  ],
)

/** Daily rollups, kept indefinitely; '' stands for "none" in the key columns. */
export const hubTraceDaily = pgTable(
  'hub_trace_daily',
  {
    day: date('day').notNull(),
    kind: text('kind').notNull(),
    tool: text('tool').default('').notNull(),
    model: text('model').default('').notNull(),
    logContext: text('log_context').default('').notNull(),
    appVersion: text('app_version').notNull(),
    spans: integer('spans').notNull(),
    errors: integer('errors').notNull(),
    installs: integer('installs').notNull(),
    p50Ms: integer('p50_ms'),
    p95Ms: integer('p95_ms'),
    tokensIn: bigint('tokens_in', { mode: 'number' }).notNull(),
    tokensOut: bigint('tokens_out', { mode: 'number' }).notNull(),
    costUsd: doublePrecision('cost_usd').notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.kind, t.tool, t.model, t.logContext, t.appVersion], name: 'hub_trace_daily_pk' })],
)
