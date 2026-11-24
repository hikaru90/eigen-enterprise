import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.schema'
import { coworkerRun } from './coworkers.schema'
import { decisionLog } from './decisions.schema'
import { messageConversations } from './messages.schema'

/**
 * AI Co-workers C7 · event reactions (migrations 0176, 0177, plan/phase-ai-coworkers.md §8 C7).
 * Company-level tables without RLS (like coworker_run): the coworkers.* tools decide who
 * reads and changes what.
 */

/** The closed set of event kinds a co-worker can be switched on for. */
export const COWORKER_EVENT_KINDS = ['channel_message'] as const
export type CoworkerEventKind = (typeof COWORKER_EVENT_KINDS)[number]

/**
 * What became of one event for one co-worker it could be for (one row per co-worker and event).
 * `skipped_rate_limit` is historical: rows from before 0177, when a co-worker had an hourly
 * decision limit; it is no longer produced.
 */
export const COWORKER_EVENT_OUTCOMES = ['claimed', 'observed', 'queued', 'skipped_rate_limit', 'skipped_daily_cap', 'skipped_author_cap', 'failed'] as const
export type CoworkerEventOutcome = (typeof COWORKER_EVENT_OUTCOMES)[number]

/** What became of routing one event (one row per event: the one Jev call for every co-worker it could be for). */
export const COWORKER_EVENT_ROUTE_OUTCOMES = ['claimed', 'decided', 'skipped_author_cap', 'skipped_daily_cap', 'failed'] as const
export type CoworkerEventRouteOutcome = (typeof COWORKER_EVENT_ROUTE_OUTCOMES)[number]

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
 * One event routed (0177): the cross-process claim (unique per kind and event id) that makes
 * the assistant's routing call happen once per event, and its outcome. Where it happened and
 * who wrote it only — never the event's content.
 */
export const coworkerEventRoute = pgTable(
  'coworker_event_route',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventKind: text('event_kind').$type<CoworkerEventKind>().notNull(),
    eventId: text('event_id').notNull(),
    conversationId: uuid('conversation_id').references(() => messageConversations.id, { onDelete: 'set null' }),
    /** The message's author: the routing call is billed to them. */
    authorUserId: text('author_user_id').notNull(),
    outcome: text('outcome').$type<CoworkerEventRouteOutcome>().notNull(),
    /** Co-workers the event could be for (one observation row each). */
    candidates: integer('candidates').notNull(),
    /** Questions asked in the one call (candidates whose own daily cap was spent are left out). */
    questions: integer('questions').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('coworker_event_route_event_unique').on(t.eventKind, t.eventId),
    check('coworker_event_route_kind_check', sql`${t.eventKind} IN ('channel_message')`),
    check('coworker_event_route_outcome_check', sql`${t.outcome} IN ('claimed', 'decided', 'skipped_author_cap', 'skipped_daily_cap', 'failed')`),
    check('coworker_event_route_counts_check', sql`${t.candidates} >= 1 AND ${t.questions} >= 0 AND ${t.questions} <= ${t.candidates}`),
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
    /** The routing it was part of (0177); null for rows made before routing. */
    routeId: uuid('route_id').references(() => coworkerEventRoute.id, { onDelete: 'set null' }),
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
      sql`${t.outcome} IN ('claimed', 'observed', 'queued', 'skipped_rate_limit', 'skipped_daily_cap', 'skipped_author_cap', 'failed')`,
    ),
  ],
)
