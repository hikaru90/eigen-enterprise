import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { JourneyState } from '$lib/kernel/playbook'

/**
 * Company journeys (phase: the website-founding journey) — durable state for
 * the declarative conversation journeys defined on JourneySpec/`playbook.ts`.
 * Not wired into schema.ts; consumed only by the kernel playbook store
 * (DbJourneyStore). One ACTIVE journey per kind is DB-enforced by a partial
 * unique index (drizzle/0077_journeys.sql) so a second founding journey can
 * never silently coexist with an open one.
 */

export const kernelJourneys = pgTable('kernel_journeys', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  status: text('status', { enum: ['active', 'completed', 'abandoned'] })
    .default('active')
    .notNull(),
  state: jsonb('state').$type<JourneyState>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
