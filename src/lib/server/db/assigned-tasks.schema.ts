import { date, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Assigned tasks (migration 0159): one member assigns a task to another
 * member. Company-level tables (no RLS), like messages and calls: access is
 * decided in the service (src/lib/server/memory/assigned-tasks/service.ts) —
 * only the assigner and the assignee read or change a task. Not Memory:
 * nothing here reads or links the assigner's private thoughts.
 */

export const assignedTasks = pgTable('assigned_tasks', {
  id: uuid('id').primaryKey(),
  assignerId: text('assigner_id').notNull(),
  assigneeId: text('assignee_id').notNull(),
  title: text('title').notNull(),
  context: text('context').default('').notNull(),
  /** A calendar day (YYYY-MM-DD); null = no due date. */
  dueOn: date('due_on', { mode: 'string' }),
  status: text('status', { enum: ['open', 'done'] }).default('open').notNull(),
  /** 'assistant' = the assigner's assistant created it on their word in chat. */
  createdVia: text('created_via', { enum: ['person', 'assistant'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  /** The latest thing that happened for the assignee, and when they last acknowledged one. */
  assigneeUpdate: text('assignee_update', { enum: ['assigned', 'commented'] }),
  assigneeUpdateAt: timestamp('assignee_update_at', { withTimezone: true }),
  assigneeSeenAt: timestamp('assignee_seen_at', { withTimezone: true }),
  /** The latest thing that happened for the assigner (completed, commented), and when they last acknowledged one. */
  assignerUpdate: text('assigner_update', { enum: ['completed', 'commented'] }),
  assignerUpdateAt: timestamp('assigner_update_at', { withTimezone: true }),
  assignerSeenAt: timestamp('assigner_seen_at', { withTimezone: true }),
})

export const assignedTaskComments = pgTable('assigned_task_comments', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id')
    .notNull()
    .references(() => assignedTasks.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
