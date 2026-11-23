import { sql } from 'drizzle-orm'
import { boolean, check, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.schema'
import { messageConversations, messages } from './messages.schema'

/**
 * AI co-workers and the org chart (migration 0170, plan/phase-ai-coworkers.md §4).
 * Company-level tables (no RLS, like member_group): every member reads the org
 * chart and the co-workers; writes go through the coworkers.* / org.* registry
 * tools, which decide who may.
 */

/** One seat in the company-wide org chart: people and co-workers alike. Cycles are refused in the service. */
export const orgPosition = pgTable(
  'org_position',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title'),
    reportsToUserId: text('reports_to_user_id').references(() => user.id, { onDelete: 'set null' }),
    accountabilities: text('accountabilities').array().notNull().default(sql`'{}'`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [
    index('org_position_reports_to_idx').on(t.reportsToUserId),
    check('org_position_not_self', sql`${t.reportsToUserId} IS NULL OR ${t.reportsToUserId} <> ${t.userId}`),
  ],
)

/**
 * A co-worker's role card and runtime settings (user.kind = 'coworker'). Removing a
 * co-worker keeps its user row (what it authored stays attributed): removed_at is set
 * and it is switched off for good.
 */
export const coworkerProfile = pgTable(
  'coworker_profile',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    /** The role prompt: what it cares about, what it pushes back on. */
    lens: text('lens').notNull(),
    /** A chat-slot model of the curated pool ($lib/server/llm/model-pool.ts), validated on write. */
    modelId: text('model_id').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    dailyCapUsd: numeric('daily_cap_usd', { precision: 12, scale: 4 }).notNull(),
    templateId: text('template_id'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedBy: text('removed_by'),
  },
  (t) => [
    uniqueIndex('coworker_profile_slug_unique').on(t.slug),
    check('coworker_profile_daily_cap_positive', sql`${t.dailyCapUsd} > 0`),
    check('coworker_profile_removed_is_disabled', sql`${t.removedAt} IS NULL OR ${t.enabled} = false`),
  ],
)

export const COWORKER_TRIGGER_KINDS = ['mention', 'dm', 'assignment', 'rhythm', 'event'] as const
export type CoworkerTriggerKind = (typeof COWORKER_TRIGGER_KINDS)[number]
export const COWORKER_RUN_STATUSES = ['running', 'done', 'failed', 'stopped'] as const
export type CoworkerRunStatus = (typeof COWORKER_RUN_STATUSES)[number]

/** One co-worker turn: the visible run log (written from C3). */
export const coworkerRun = pgTable(
  'coworker_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    coworkerUserId: text('coworker_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    triggerKind: text('trigger_kind', { enum: COWORKER_TRIGGER_KINDS }).notNull(),
    conversationId: uuid('conversation_id').references(() => messageConversations.id, { onDelete: 'set null' }),
    threadRootId: uuid('thread_root_id').references(() => messages.id, { onDelete: 'set null' }),
    requestedByUserId: text('requested_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    status: text('status', { enum: COWORKER_RUN_STATUSES }).default('running').notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    index('coworker_run_coworker_started_idx').on(t.coworkerUserId, t.startedAt.desc()),
    check('coworker_run_trigger_kind_check', sql`${t.triggerKind} IN ('mention', 'dm', 'assignment', 'rhythm', 'event')`),
    check('coworker_run_status_check', sql`${t.status} IN ('running', 'done', 'failed', 'stopped')`),
  ],
)
