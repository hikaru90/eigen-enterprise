import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Roadmap module table — the company's build log, queue, and plan rendered
 * under /settings/extensions. Not wired into schema.ts; consumed only by the
 * modules/orchestrator/roadmap store. The status/kind vocabularies live as DB check
 * constraints and are re-validated at the module's tool boundary (zod).
 */
export const extensionRoadmapItems = pgTable('extension_roadmap_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  detail: text('detail').default('').notNull(),
  status: text('status', { enum: ['shipped', 'in_progress', 'planned'] })
    .default('planned')
    .notNull(),
  kind: text('kind', { enum: ['feature', 'fix', 'chore'] }).default('feature').notNull(),
  position: integer('position').default(0).notNull(),
  shippedAt: timestamp('shipped_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
