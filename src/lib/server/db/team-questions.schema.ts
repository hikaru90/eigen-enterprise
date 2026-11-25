import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Team questions (migration 0183, Contribute 057cd4d5): a member puts a short
 * question to the whole company or to chosen groups and people, with free
 * tags; they answer it in Memory › Questions. Company-level tables (no RLS),
 * like assigned tasks: access is decided in the service
 * (src/lib/server/memory/team-questions/service.ts) — the asker and the
 * audience read it, only the asker closes it.
 */

export const teamQuestions = pgTable(
  'team_questions',
  {
    id: uuid('id').primaryKey(),
    authorId: text('author_id').notNull(),
    text: text('text').notNull(),
    /** Normalised free tags (trimmed, lower case), at most 8. */
    tags: text('tags').array().notNull(),
    /** 'company' = every member; 'chosen' = the groups and people below. */
    audienceKind: text('audience_kind', { enum: ['company', 'chosen'] }).notNull(),
    audienceGroupIds: text('audience_group_ids').array().notNull(),
    audienceUserIds: text('audience_user_ids').array().notNull(),
    status: text('status', { enum: ['open', 'closed'] }).default('open').notNull(),
    /** 'assistant' = the asker's assistant posted it on their word in chat. */
    createdVia: text('created_via', { enum: ['person', 'assistant'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('team_questions_created_idx').on(t.createdAt)],
)

export const teamQuestionAnswers = pgTable(
  'team_question_answers',
  {
    id: uuid('id').primaryKey(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => teamQuestions.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    createdVia: text('created_via', { enum: ['person', 'assistant'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('team_question_answers_question_idx').on(t.questionId, t.createdAt)],
)
