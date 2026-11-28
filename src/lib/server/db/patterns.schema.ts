import { index, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { PatternItem } from '$lib/server/patterns/digest'

/**
 * What's happening (wish 75a4e570, migration 0193): one row per digest of observable activity.
 * Company-level, no RLS: dashboard.patterns filters the items per viewer (module active, roles).
 */
export const patternDigest = pgTable(
  'pattern_digest',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    items: jsonb('items').$type<PatternItem[]>().notNull(),
  },
  (t) => [index('pattern_digest_created_at_idx').on(t.createdAt.desc())],
)
