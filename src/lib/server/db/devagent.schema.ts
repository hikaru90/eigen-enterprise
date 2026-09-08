import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Dev-agent module tables — one row per headless pi coding-agent run in its
 * git worktree sandbox. Consumed only by modules/dev-agent stores.
 */

export const kernelDevagentRuns = pgTable('kernel_devagent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  task: text('task').notNull(),
  status: text('status').notNull(),
  branch: text('branch').notNull(),
  worktreePath: text('worktree_path').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  resultSummary: text('result_summary'),
  green: boolean('green'),
  error: text('error'),
})
