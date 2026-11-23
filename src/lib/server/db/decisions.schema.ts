import { sql } from 'drizzle-orm'
import { doublePrecision, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.schema'

/**
 * CB2 · Jev in the gateway (migration 0175, plan/phase-company-brain.md §5): one row per
 * decision of a declared decision kind (src/lib/server/decisions). Company-level, no RLS:
 * the decisions.* registry tools decide who reads which rows.
 */

export const DECISION_STATUSES = ['shadow', 'enforced'] as const
export type DecisionStatus = (typeof DECISION_STATUSES)[number]

/** What decide() returned: a choice, a question for a person, observation only (shadow, no current judge), or a failure. */
export const DECISION_OUTCOMES = ['decided', 'pending', 'observed', 'failed'] as const
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number]

/** Whose answer the caller acted on. */
export const DECISION_SOURCES = ['jev', 'current_judge', 'human'] as const
export type DecisionSource = (typeof DECISION_SOURCES)[number]

export const decisionLog = pgTable(
  'decision_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    module: text('module').notNull(),
    /** The kind's status when this decision was made. */
    status: text('status').$type<DecisionStatus>().notNull(),
    outcome: text('outcome').$type<DecisionOutcome>().notNull(),
    /** sha256 of the full input (canonical JSON): a re-ask finds its question. */
    inputDigest: text('input_digest').notNull(),
    /** The kind's log view of the input, secret-redacted. */
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    jevChoice: text('jev_choice'),
    jevConfidence: doublePrecision('jev_confidence'),
    jevDistribution: jsonb('jev_distribution').$type<Record<string, number>>(),
    /** Why Jev gave no answer (shadow: logged, the current judge's answer stands). */
    jevError: text('jev_error'),
    model: text('model'),
    /** Provider-reported USD of the Jev call. */
    costUsd: numeric('cost_usd', { precision: 14, scale: 10 }),
    durationMs: integer('duration_ms'),
    /** The current judge's answer (shadow comparison); null when the kind has none or is enforced. */
    judgeChoice: text('judge_choice'),
    /** The answer the caller acted on; null for a question still open or an observation. */
    usedChoice: text('used_choice'),
    usedSource: text('used_source').$type<DecisionSource>(),
    /** The person the decision is about, if any. */
    subjectUserId: text('subject_user_id').references(() => user.id, { onDelete: 'set null' }),
    /** The principal the decision was made for (its cost is on this id). */
    requestedBy: text('requested_by').notNull(),
    /** Who is asked when Jev is unsure (enforced kinds only). */
    askUserId: text('ask_user_id').references(() => user.id, { onDelete: 'set null' }),
    question: text('question'),
    /** A person's answer: the human label agreement is measured against. */
    humanChoice: text('human_choice'),
    labelledBy: text('labelled_by'),
    labelledAt: timestamp('labelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('decision_log_kind_idx').on(t.kind, t.createdAt),
    index('decision_log_digest_idx').on(t.kind, t.inputDigest),
    index('decision_log_open_question_idx')
      .on(t.askUserId, t.createdAt)
      .where(sql`${t.outcome} = 'pending' AND ${t.humanChoice} IS NULL`),
  ],
)

export type DecisionLogRow = typeof decisionLog.$inferSelect
