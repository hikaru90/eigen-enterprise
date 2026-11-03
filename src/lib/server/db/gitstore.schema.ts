import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** Per-surface index watermark (migration 0113, plan/phase-git-native.md). */
export const gitstoreWatermark = pgTable('gitstore_watermark', {
  surface: text('surface').primaryKey(),
  commit: text('commit').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
