import { pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Contribute (migration 0121). Company-level tables (no RLS): access is
 * decided in the contribute service (modules/contribute/service.ts).
 */

export const contributions = pgTable('contributions', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  kind: text('kind', { enum: ['idea', 'bug', 'polish'] }).notNull(),
  area: text('area', {
    enum: ['dashboard', 'assistant', 'messages', 'website', 'email', 'brand', 'memory', 'drive', 'settings', 'contribute', 'everywhere'],
  }).notNull(),
  status: text('status', { enum: ['requested', 'in_progress', 'shipped', 'declined'] })
    .default('requested')
    .notNull(),
  authorId: text('author_id').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  shippedAt: timestamp('shipped_at', { withTimezone: true }),
})

export const contributionVotes = pgTable(
  'contribution_votes',
  {
    contributionId: uuid('contribution_id')
      .notNull()
      .references(() => contributions.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    direction: smallint('direction').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.contributionId, t.userId], name: 'contribution_votes_pk' })],
)
