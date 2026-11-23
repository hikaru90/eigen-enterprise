import { sql } from 'drizzle-orm'
import { check, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.schema'
import { coworkerRun } from './coworkers.schema'
import { decisionLog } from './decisions.schema'
import { messageConversations } from './messages.schema'

/**
 * AI Co-workers C7 · event reactions (migration 0176, plan/phase-ai-coworkers.md §8 C7).
 * Company-level tables without RLS (like coworker_run): the coworkers.* tools decide who
 * reads and changes what.
 */

/** The closed set of event kinds a co-worker can be switched on for. */
export const COWORKER_EVENT_KINDS = ['channel_message'] as const
export type CoworkerEventKind = (typeof COWORKER_EVENT_KINDS)[number]

/** What became of one event a co-worker heard (one row per co-worker and event). */
export const COWORKER_EVENT_OUTCOMES = ['claimed', 'observed', 'queued', 'skipped_rate_limit', 'skipped_daily_cap', 'failed'] as const
export type CoworkerEventOutcome = (typeof COWORKER_EVENT_OUTCOMES)[number]

/** An event kind an admin switched on for a co-worker; no row = off. */
export const coworkerEventSubscription = pgTable(
  'coworker_event_subscription',
  {
    coworkerUserId: text('coworker_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    eventKind: text('event_kind').$type<CoworkerEventKind>().notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: 'coworker_event_subscription_pk', columns: [t.coworkerUserId, t.eventKind] }),
    check('coworker_event_subscription_kind_check', sql`${t.eventKind} IN ('channel_message')`),
  ],
)

/**
 * One event one co-worker heard: the cross-process claim (unique per co-worker, kind and
 * event id) and its counted outcome. Where it happened only — never the event's content.
 */
export const coworkerEventObservation = pgTable(
  'coworker_event_observation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    coworkerUserId: text('coworker_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    eventKind: text('event_kind').$type<CoworkerEventKind>().notNull(),
    eventId: text('event_id').notNull(),
    conversationId: uuid('conversation_id').references(() => messageConversations.id, { onDelete: 'set null' }),
    outcome: text('outcome').$type<CoworkerEventOutcome>().notNull(),
    decisionId: uuid('decision_id').references(() => decisionLog.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => coworkerRun.id, { onDelete: 'set null' }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('coworker_event_observation_event_unique').on(t.coworkerUserId, t.eventKind, t.eventId),
    index('coworker_event_observation_recent_idx').on(t.coworkerUserId, t.createdAt),
    check('coworker_event_observation_kind_check', sql`${t.eventKind} IN ('channel_message')`),
    check(
      'coworker_event_observation_outcome_check',
      sql`${t.outcome} IN ('claimed', 'observed', 'queued', 'skipped_rate_limit', 'skipped_daily_cap', 'failed')`,
    ),
  ],
)
