import { sql } from 'drizzle-orm'
import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { assignedTasks } from './assigned-tasks.schema'

/**
 * Handover (migration 0184, plan/handover.md): a page per person or per topic
 * with one entry per topic — day, topic, one sentence, status, link. Company-
 * level tables (no RLS), like assigned tasks: every member reads every
 * handover, only its owner writes; access is decided in the service
 * (src/lib/server/memory/handover/service.ts).
 */

export const handovers = pgTable(
  'handovers',
  {
    id: uuid('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    title: text('title').notNull(),
    /** The member the handover is for; null = a topic handover. */
    subjectId: text('subject_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('handovers_updated_idx').on(t.updatedAt)],
)

export const handoverEntries = pgTable(
  'handover_entries',
  {
    id: uuid('id').primaryKey(),
    handoverId: uuid('handover_id')
      .notNull()
      .references(() => handovers.id, { onDelete: 'cascade' }),
    /** The day the entry speaks for (YYYY-MM-DD). */
    entryOn: date('entry_on', { mode: 'string' }).notNull(),
    topic: text('topic').notNull(),
    sentence: text('sentence').notNull(),
    status: text('status', { enum: ['decision_needed', 'in_progress', 'for_info'] }).notNull(),
    /** An app path or an http(s) URL to the detail; null = none. */
    link: text('link'),
    assigneeId: text('assignee_id'),
    assignedTaskId: uuid('assigned_task_id').references(() => assignedTasks.id, { onDelete: 'set null' }),
    /** Who wrote it last: the owner, their assistant, or the brain's upkeep. */
    writtenVia: text('written_via', { enum: ['person', 'assistant', 'brain'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('handover_entries_topic_uidx').on(t.handoverId, sql`lower(btrim(${t.topic}))`),
    index('handover_entries_newest_idx').on(t.handoverId, t.entryOn, t.updatedAt),
  ],
)
